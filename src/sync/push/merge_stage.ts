/*
 * Copyright (C) 2026 SPORT-SERVICE RS★R
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '../../client/error.js';
import { apiResponseToLocal } from '../../client/mapper.js';
import { articleContentEndpoint } from '../../client/endpoints.js';
import { readBaseline, readBaselineFrontmatter, createBaseSnapshot } from '../../db/baseline.js';
import type { BaseSnapshot, SyncState } from '../../db/cache.js';
import {
  serializeMarkdown,
  type ParsedMarkdown,
  type TaxonomyCandidates,
} from '../../utils/frontmatter.js';
import { hybrid3WayMerge, type MergeResult } from '../merge.js';
import { fetchAssignedTaxonomies, computeTaxonomyHash } from '../terms.js';
import { calculateHash, quarantineLocalCopy } from '../workspace/index.js';
import { throwRemoteArticleDeleted } from './transport.js';
import { pendingFlagsFor } from './commit.js';
import type { PushOptions, PushResult } from './types.js';

export interface ConflictResolutionOutcome {
  handled: boolean;
  pushResult?: PushResult;
  mergedParsed?: ParsedMarkdown;
  remoteParsedRev?: string;
  mergeResult?: MergeResult;
}

/**
 * Handles 409 conflict, performs GET remote, and executes Hybrid 3-Way Merge.
 * If conflicts remain unresolved, writes conflict markers, saves quarantine copy and returns PushResult.
 * If merged cleanly, returns mergedParsed and remoteParsedRev for PUT retry.
 */
export async function resolveConflictAndMerge(params: {
  collection: string;
  id: string;
  targetFilePath: string;
  fullPath: string;
  putUrl: string;
  res?: Response | null;
  taxonomyDivergenceDetected?: boolean;
  parsed: ParsedMarkdown;
  syncState: SyncState | null | undefined;
  baseSnapshot: BaseSnapshot | null | undefined;
  remoteTaxAudit: { categories: string[] | null; tags: string[] | null } | null;
  candidates: TaxonomyCandidates;
  options: PushOptions;
  fetchFn: typeof fetch;
  warnings: string[];
}): Promise<ConflictResolutionOutcome> {
  const {
    collection,
    id,
    targetFilePath,
    fullPath,
    putUrl,
    res,
    taxonomyDivergenceDetected,
    parsed,
    syncState,
    baseSnapshot,
    remoteTaxAudit,
    candidates,
    options,
    fetchFn,
    warnings,
  } = params;

  if (res && !taxonomyDivergenceDetected) {
    const errJson = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; holder?: unknown };
    };
    const errorCode = errJson.error?.code || 'CONFLICT';

    if (errorCode === 'ENTRY_LOCKED') {
      throw new ApiError({
        message: `Entry is currently locked by another user. (${errJson.error?.message || ''})`,
        code: 'ENTRY_LOCKED',
        status: 409,
        endpoint: putUrl,
        suggestion:
          'Wait for the other user to finish editing or release their lock before retrying.',
      });
    }
  }

  // True revision mismatch conflict or taxonomy divergence: fetch remote latest and run Hybrid 3-Way Merge
  const getUrl = articleContentEndpoint(options.origin, collection, id);
  const getRes = await fetchFn(getUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/json',
    },
  });

  if (!getRes.ok) {
    if (getRes.status === 404 || getRes.status === 410) {
      throwRemoteArticleDeleted(collection, id, targetFilePath, getUrl);
    }
    throw new ApiError({
      message: `Failed to fetch latest remote version during conflict resolution: ${getRes.statusText}`,
      code: 'CONFLICT_REMOTE_FETCH_FAILED',
      status: getRes.status,
      endpoint: getUrl,
      suggestion: 'Check remote server availability to resolve conflict.',
    });
  }

  const remoteItem = (await getRes.json()) as Record<string, unknown>;
  const remoteParsed = apiResponseToLocal(remoteItem, options);

  // Fetch remote taxonomy assignments (reuse remoteTaxAudit if available)
  const remoteTax =
    remoteTaxAudit ||
    (await fetchAssignedTaxonomies({
      origin: options.origin,
      token: options.token,
      collection,
      id,
      fetchFn,
    }));

  if (!remoteParsed.frontmatter.taxonomies) {
    remoteParsed.frontmatter.taxonomies = {};
  }
  const baseFm = readBaselineFrontmatter(baseSnapshot);
  if (remoteTax.categories !== null) {
    remoteParsed.frontmatter.taxonomies.categories = remoteTax.categories;
  } else if (baseFm?.taxonomies?.categories) {
    remoteParsed.frontmatter.taxonomies.categories = baseFm.taxonomies.categories;
  }
  if (remoteTax.tags !== null) {
    remoteParsed.frontmatter.taxonomies.tags = remoteTax.tags;
  } else if (baseFm?.taxonomies?.tags) {
    remoteParsed.frontmatter.taxonomies.tags = baseFm.taxonomies.tags;
  }

  // Perform Hybrid 3-Way Merge
  const baseInfo = baseSnapshot ? readBaseline(baseSnapshot) : null;

  const mergeResult = hybrid3WayMerge(
    parsed,
    baseInfo,
    {
      frontmatter: remoteParsed.frontmatter,
      body: remoteParsed.body,
    },
    {
      strategy: options.resolveTaxonomy,
    },
  );

  warnings.push(...mergeResult.warnings);

  // Check destructive taxonomy wipe guard during 3-way merge (exempt if strategy is explicitly specified)
  if (!options.resolveTaxonomy && mergeResult.wipeWarnings && mergeResult.wipeWarnings.length > 0) {
    if (!options.allowWipeTaxonomies && !options.force) {
      const details = mergeResult.wipeWarnings
        .map((w) => `${w.name}: clearing ${w.remoteTerms.length} assignment(s)`)
        .join(', ');
      throw new ApiError({
        endpoint: `/_emdash/api/content/${collection}/${id}`,
        code: 'DESTRUCTIVE_TAXONOMY_WIPE',
        status: 400,
        message: `Local article specified empty array for taxonomies (${details}), which would wipe existing remote assignments.`,
        suggestion: `Pass --allow-wipe-taxonomies (or --force) to confirm clearing: "emit push ${targetFilePath} --allow-wipe-taxonomies"`,
      });
    }
  }

  // Log clean auto-merged taxonomy changes
  if (mergeResult.autoMergedTaxonomies && mergeResult.autoMergedTaxonomies.length > 0) {
    for (const item of mergeResult.autoMergedTaxonomies) {
      const parts: string[] = [];
      if (item.remoteAdded.length > 0) parts.push(`+${item.remoteAdded.join(', ')}`);
      if (item.remoteRemoved.length > 0) parts.push(`-${item.remoteRemoved.join(', ')}`);
      warnings.push(`🏷️ Merged remote taxonomy change(s) for ${item.name}: ${parts.join(' ')}`);
    }
  }

  // Log strategy adoptions
  if (mergeResult.strategyAdoptions && mergeResult.strategyAdoptions.length > 0) {
    for (const item of mergeResult.strategyAdoptions) {
      const parts: string[] = [];
      if (item.discardedAdded.length > 0) parts.push(`+${item.discardedAdded.join(', ')}`);
      if (item.discardedRemoved.length > 0) parts.push(`-${item.discardedRemoved.join(', ')}`);
      const discardedStr = parts.length > 0 ? `: discarded ${parts.join(' ')}` : '';
      warnings.push(`🏷️ Resolved '${item.name}' with strategy '${item.side}'${discardedStr}.`);
    }
  }

  // Fallback post-merge resolution only if strategy was NOT specified and taxonomy conflicts occurred
  if (
    !options.resolveTaxonomy &&
    mergeResult.taxonomyConflicts &&
    mergeResult.taxonomyConflicts.length > 0
  ) {
    if (options.force) {
      const strategy = 'union';
      const unionTaxonomies: Record<string, string[]> = {};
      const allTaxNames = new Set([
        ...Object.keys(parsed.frontmatter.taxonomies || {}),
        ...Object.keys(remoteParsed.frontmatter.taxonomies || {}),
      ]);
      for (const tName of allTaxNames) {
        const lTerms = parsed.frontmatter.taxonomies?.[tName] || [];
        const rTerms = remoteParsed.frontmatter.taxonomies?.[tName] || [];
        unionTaxonomies[tName] = Array.from(new Set([...lTerms, ...rTerms]));
      }
      mergeResult.frontmatter.taxonomies = unionTaxonomies;
      warnings.push(`Resolved taxonomy conflicts using strategy '${strategy}'.`);
    } else {
      mergeResult.hasConflict = true;
      warnings.push(
        `Conflict on taxonomies (${mergeResult.taxonomyConflicts.join(', ')}): local and remote changes could not be cleanly merged. Push aborted to prevent data loss.`,
      );
    }
  }

  if (mergeResult.hasConflict) {
    const isTaxonomyConflict = Boolean(
      mergeResult.taxonomyConflicts && mergeResult.taxonomyConflicts.length > 0,
    );
    const hasBodyConflict = Boolean(
      mergeResult.body.includes('<<<<<<< LOCAL') || mergeResult.body.includes('<<<<<<< local'),
    );
    const isTaxonomyOnlyConflict = isTaxonomyConflict && !hasBodyConflict;

    const conflictedMarkdown = serializeMarkdown(
      mergeResult.frontmatter,
      mergeResult.body,
      options.candidates,
    );
    let quarantineRel: string | null = null;
    // Only write conflict markers into the article body if body actually has conflicts
    if (!isTaxonomyOnlyConflict) {
      const currentDisk = fs.readFileSync(fullPath, 'utf8');
      quarantineRel = quarantineLocalCopy(
        options.workspaceRoot,
        collection,
        targetFilePath,
        currentDisk,
        { isForce: false },
      );
      fs.writeFileSync(fullPath, conflictedMarkdown, 'utf8');
    }

    let actualConflictCopyHash: string | null = null;
    if (quarantineRel) {
      const qFull = path.join(options.workspaceRoot, quarantineRel);
      if (fs.existsSync(qFull)) {
        actualConflictCopyHash = calculateHash(fs.readFileSync(qFull, 'utf8'));
      }
    }

    const remoteTaxHash = computeTaxonomyHash(
      remoteParsed.frontmatter.taxonomies?.categories,
      remoteParsed.frontmatter.taxonomies?.tags,
    );

    const flags = pendingFlagsFor({
      mode: 'conflict',
      hasBodyConflict,
      isTaxonomyConflict,
      conflictedHash: actualConflictCopyHash,
      quarantineRelPath: quarantineRel,
      remoteTaxonomyHash: remoteTaxHash,
    });

    // Update sync state:
    // Do NOT overwrite localHash with marker hash, so `status` remains clean when markers are cleaned up!
    options.cache.saveSyncState({
      id,
      localFilePath: targetFilePath,
      localHash: syncState?.localHash || '',
      remoteRev: remoteParsed.rev,
      status: parsed.frontmatter.status,
      slug: parsed.frontmatter.slug,
      lastSyncedAt: Math.floor(Date.now() / 1000),
      ...flags,
    });

    options.cache.saveBaseSnapshot(
      createBaseSnapshot({
        id,
        rev: remoteParsed.rev,
        bodyMarkdown: remoteParsed.body,
        frontmatter: remoteParsed.frontmatter,
        hash: calculateHash(
          serializeMarkdown(remoteParsed.frontmatter, remoteParsed.body, candidates),
        ),
      }),
    );

    return {
      handled: true,
      pushResult: {
        success: false,
        id,
        rev: remoteParsed.rev,
        filePath: targetFilePath,
        conflict: true,
        taxonomyConflict: isTaxonomyOnlyConflict,
        warnings,
      },
    };
  }

  // Cleanly merged: return mergedParsed for PUT retry
  parsed.frontmatter = mergeResult.frontmatter;
  parsed.body = mergeResult.body;
  return {
    handled: false,
    mergedParsed: parsed,
    remoteParsedRev: remoteParsed.rev,
    mergeResult,
  };
}

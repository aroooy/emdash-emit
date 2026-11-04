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
import type { CacheDatabase } from '../db/cache.js';
import { withEntryLock } from '../client/lock.js';
import { apiResponseToLocal, localToApiPayload, type MapperOptions } from '../client/mapper.js';
import { ApiError } from '../client/error.js';
import { createAuthedFetch } from '../client/http.js';
import { unwrapItem, extractRev } from '../client/api.js';
import {
  computeArticleRelativePath,
  extractDatePrefixFromPath,
  parseMarkdown,
  serializeMarkdown,
  type Frontmatter,
  type TaxonomyCandidates,
} from '../utils/frontmatter.js';
import { loadLocalTaxonomyMaps } from './taxonomies.js';
import { runPreflightChecks, type PreflightError } from './preflight.js';
import { calculateHash } from './pull.js';
import { hybrid3WayMerge } from './merge.js';

export interface PushOptions extends MapperOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token: string;
  refreshToken?: string;
  fetchFn?: typeof fetch;
  candidates?: TaxonomyCandidates;
  knownTaxonomies?: Record<string, string[]>;
}

export interface PushResult {
  success: boolean;
  id: string;
  rev: string;
  filePath: string;
  conflict: boolean;
  warnings: string[];
  errors?: PreflightError[];
}

export class PushValidationError extends Error {
  public errors: PreflightError[];

  constructor(message: string, errors: PreflightError[]) {
    super(message);
    this.name = 'PushValidationError';
    this.errors = errors;
  }
}

/**
 * Pushes a local markdown article to remote EmDash with full preflight guards,
 * two-tier lock lease protection, and automatic 3-way merge on conflict.
 */
export async function pushArticle(
  targetFilePath: string,
  options: PushOptions,
): Promise<PushResult> {
  const fetchFn = createAuthedFetch(options);
  const fullPath = path.isAbsolute(targetFilePath)
    ? targetFilePath
    : path.join(options.workspaceRoot, targetFilePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Target file not found: ${targetFilePath}`);
  }

  const rawContent = fs.readFileSync(fullPath, 'utf8');
  const parsed = parseMarkdown(rawContent);
  const id = parsed.frontmatter.id;
  const collection = parsed.frontmatter.collection;

  // Retrieve sync state and base snapshot
  const syncState = options.cache.getSyncState(id);
  const baseSnapshot = options.cache.getBaseSnapshot(id);

  // 1. Run Preflight Guards G2 - G9
  const preflight = runPreflightChecks(targetFilePath, parsed, {
    allowPublish: options.allowPublish,
    knownTaxonomies: options.knownTaxonomies,
    baseMarkdown: baseSnapshot?.bodyMarkdown,
    previousStatus: (syncState?.status as 'draft' | 'published') || 'draft',
  });

  if (!preflight.valid) {
    throw new PushValidationError(
      `Push blocked by Preflight Guards (${preflight.errors.length} error(s)).`,
      preflight.errors,
    );
  }

  // Update parsed with cleaned body (e.g. trimmed duplicate heading)
  parsed.body = preflight.cleanedBody;

  const currentRev = syncState?.remoteRev || baseSnapshot?.rev || '';
  const warnings = [...preflight.warnings];

  // 2. Determine whether this is a new article create (POST) or update (PUT)
  const isNewArticle = !syncState;

  // Helper to synchronize taxonomy assignments
  const syncArticleTaxonomies = async (articleId: string) => {
    if (!parsed.frontmatter.taxonomies) return;
    const taxMaps = loadLocalTaxonomyMaps(options.workspaceRoot);

    const updateTaxonomy = async (taxonomyName: 'category' | 'tag', termSlugsOrIds: string[]) => {
      const slugMap = taxMaps.slugToId[taxonomyName] || {};
      const resolvedTermIds = termSlugsOrIds
        .map((item) => slugMap[item] || item)
        .filter((tid): tid is string => Boolean(tid));

      const termsUrl = new URL(
        `/_emdash/api/content/${collection}/${articleId}/terms/${taxonomyName}`,
        options.origin,
      ).toString();

      const termRes = await fetchFn(termsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ termIds: resolvedTermIds }),
      });

      if (!termRes.ok) {
        const errBody = await termRes.text().catch(() => '');
        warnings.push(`Failed to update ${taxonomyName} terms: ${termRes.statusText} ${errBody}`);
      }
    };

    if (parsed.frontmatter.taxonomies.categories) {
      await updateTaxonomy('category', parsed.frontmatter.taxonomies.categories);
    }
    if (parsed.frontmatter.taxonomies.tags) {
      await updateTaxonomy('tag', parsed.frontmatter.taxonomies.tags);
    }
  };

  if (isNewArticle) {
    let payload = localToApiPayload(parsed, '', options);
    const postUrl = new URL(`/_emdash/api/content/${collection}`, options.origin).toString();

    const res = await fetchFn(postUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new ApiError({
        message: `Create push failed: ${res.statusText} - ${errBody}`,
        code: 'PUSH_CREATE_FAILED',
        status: res.status,
        endpoint: postUrl,
        suggestion:
          'Check if an article with this slug already exists or if token has create permissions.',
      });
    }

    const createdJson = await res.json();
    const createdItem = unwrapItem<Record<string, unknown>>(createdJson);
    const actualId = String(createdItem.id || id);
    const newRev = extractRev(createdJson, '1');

    // Update parsed frontmatter with the actual ID returned by EmDash
    parsed.frontmatter.id = actualId;

    // Sync taxonomies for newly created article
    await syncArticleTaxonomies(actualId);

    const currentPrefix = extractDatePrefixFromPath(fullPath);
    const dateInput =
      parsed.frontmatter.publishedAt || currentPrefix || (createdItem.createdAt as string) || null;

    const newRelPath = computeArticleRelativePath(
      parsed.frontmatter.collection,
      parsed.frontmatter.status,
      actualId,
      parsed.frontmatter.title || parsed.frontmatter.slug,
      dateInput,
    );
    const newFullPath = path.join(options.workspaceRoot, newRelPath);

    const serializedContent = serializeMarkdown(
      parsed.frontmatter,
      parsed.body,
      options.candidates,
    );
    const newHash = calculateHash(serializedContent);

    // Save newly serialized file (with actual server ID)
    fs.mkdirSync(path.dirname(newFullPath), { recursive: true });
    fs.writeFileSync(newFullPath, serializedContent, 'utf8');

    // If initial local file had a provisional ID, clean it up
    if (fullPath !== newFullPath && fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch (unlinkErr: unknown) {
        warnings.push(
          `Failed to remove provisional file at ${fullPath}: ${(unlinkErr as Error).message}.`,
        );
      }
    }

    // Update Base snapshot and Sync state
    options.cache.saveBaseSnapshot({
      id: actualId,
      rev: newRev,
      bodyMarkdown: parsed.body,
      frontmatterYaml: JSON.stringify(parsed.frontmatter),
      hash: newHash,
      savedAt: Math.floor(Date.now() / 1000),
    });

    options.cache.saveSyncState({
      id: actualId,
      localFilePath: newRelPath,
      localHash: newHash,
      remoteRev: newRev,
      status: parsed.frontmatter.status,
      slug: parsed.frontmatter.slug,
      lastSyncedAt: Math.floor(Date.now() / 1000),
    });

    return {
      success: true,
      id: actualId,
      rev: newRev,
      filePath: newRelPath,
      conflict: false,
      warnings,
    };
  }

  // Existing article: execute within full 7-minute entry lock lease
  return await withEntryLock(collection, id, options, async () => {
    let payload = localToApiPayload(parsed, currentRev, options);
    const putUrl = new URL(`/_emdash/api/content/${collection}/${id}`, options.origin).toString();

    let res = await fetchFn(putUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // 3. Handle 409 Conflict
    if (res.status === 409) {
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

      // True revision mismatch conflict: fetch remote latest and run Hybrid 3-Way Merge
      const getUrl = new URL(`/_emdash/api/content/${collection}/${id}`, options.origin).toString();
      const getRes = await fetchFn(getUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/json',
        },
      });

      if (!getRes.ok) {
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

      // Perform Hybrid 3-Way Merge
      const baseInfo = baseSnapshot
        ? {
            frontmatter: JSON.parse(baseSnapshot.frontmatterYaml) as Frontmatter,
            body: baseSnapshot.bodyMarkdown,
          }
        : null;

      const mergeResult = hybrid3WayMerge(parsed, baseInfo, {
        frontmatter: remoteParsed.frontmatter,
        body: remoteParsed.body,
      });

      warnings.push(...mergeResult.warnings);

      if (mergeResult.hasConflict) {
        // Unresolvable conflict in body: write conflict markers to local file for AI/human resolution
        const conflictedMarkdown = serializeMarkdown(
          mergeResult.frontmatter,
          mergeResult.body,
          options.candidates,
        );
        fs.writeFileSync(fullPath, conflictedMarkdown, 'utf8');

        // Update sync state with latest remoteRev and update base snapshot to remote state
        // so that once conflict markers are resolved, the subsequent push sends the correct _rev
        options.cache.saveSyncState({
          id,
          localFilePath: targetFilePath,
          localHash: calculateHash(conflictedMarkdown),
          remoteRev: remoteParsed.rev,
          status: parsed.frontmatter.status,
          slug: parsed.frontmatter.slug,
          lastSyncedAt: Math.floor(Date.now() / 1000),
        });

        options.cache.saveBaseSnapshot({
          id,
          rev: remoteParsed.rev,
          bodyMarkdown: remoteParsed.body,
          frontmatterYaml: JSON.stringify(remoteParsed.frontmatter),
          hash: calculateHash(serializeMarkdown(remoteParsed.frontmatter, remoteParsed.body)),
          savedAt: Math.floor(Date.now() / 1000),
        });

        return {
          success: false,
          id,
          rev: remoteParsed.rev,
          filePath: targetFilePath,
          conflict: true,
          warnings,
        };
      }

      // Auto-merged cleanly: retry PUT with remote's _rev
      parsed.frontmatter = mergeResult.frontmatter;
      parsed.body = mergeResult.body;
      payload = localToApiPayload(parsed, remoteParsed.rev, options);

      res = await fetchFn(putUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new ApiError({
          message: `Retry push after auto-merge failed: ${res.statusText}${errText ? ` - ${errText}` : ''}`,
          code: 'PUSH_RETRY_FAILED',
          status: res.status,
          endpoint: putUrl,
          suggestion:
            'Another change might have been committed in the meantime. Try pulling again.',
        });
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new ApiError({
        message: `Push failed: ${res.statusText}${errText ? ` - ${errText}` : ''}`,
        code: 'PUSH_FAILED',
        status: res.status,
        endpoint: putUrl,
        suggestion: 'Verify network connectivity, token permissions, and article status.',
      });
    }

    const updatedJson = await res.json().catch(() => ({}));
    const newRev = extractRev(updatedJson, currentRev);

    // 4. Post-push updates & Path tracking
    // Sync taxonomies on updated article
    await syncArticleTaxonomies(id);

    const currentPrefix = extractDatePrefixFromPath(fullPath);
    const existingSync = options.cache.getSyncState(parsed.frontmatter.id);
    const dateInput =
      parsed.frontmatter.publishedAt ||
      currentPrefix ||
      (existingSync?.lastSyncedAt ? new Date(existingSync.lastSyncedAt * 1000) : null);

    const newRelPath = computeArticleRelativePath(
      parsed.frontmatter.collection,
      parsed.frontmatter.status,
      parsed.frontmatter.id,
      parsed.frontmatter.title || parsed.frontmatter.slug,
      dateInput,
    );
    const newFullPath = path.join(options.workspaceRoot, newRelPath);

    const serializedContent = serializeMarkdown(
      parsed.frontmatter,
      parsed.body,
      options.candidates,
    );
    const newHash = calculateHash(serializedContent);

    // If status or slug changed the path, move file safely
    if (fullPath !== newFullPath) {
      fs.mkdirSync(path.dirname(newFullPath), { recursive: true });
      fs.writeFileSync(newFullPath, serializedContent, 'utf8');
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch (unlinkErr: unknown) {
          warnings.push(
            `Failed to remove old file at ${fullPath} after path transition: ${(unlinkErr as Error).message}. Please remove it manually to prevent duplicates.`,
          );
        }
      }
    } else {
      fs.writeFileSync(fullPath, serializedContent, 'utf8');
    }

    // Update Base snapshot
    options.cache.saveBaseSnapshot({
      id,
      rev: newRev,
      bodyMarkdown: parsed.body,
      frontmatterYaml: JSON.stringify(parsed.frontmatter),
      hash: newHash,
      savedAt: Math.floor(Date.now() / 1000),
    });

    // Update sync state
    options.cache.saveSyncState({
      id,
      localFilePath: newRelPath,
      localHash: newHash,
      remoteRev: newRev,
      status: parsed.frontmatter.status,
      slug: parsed.frontmatter.slug,
      lastSyncedAt: Math.floor(Date.now() / 1000),
    });

    return {
      success: true,
      id,
      rev: newRev,
      filePath: newRelPath,
      conflict: false,
      warnings,
    };
  });
}

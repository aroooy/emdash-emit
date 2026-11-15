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
import { retrackLocalHashOnly } from '../../db/baseline.js';
import { apiResponseToLocal } from '../../client/mapper.js';
import { extractRev, extractComparisonRev, isSameRev } from '../../client/api.js';
import {
  carriesPercentEncodedTaxonomy,
  extractDatePrefixFromPath,
  parseMarkdown,
  serializeMarkdown,
  lenientRepairMarkdownFrontmatter,
} from '../../utils/frontmatter.js';
import { hasUncommittedDraftRevision } from '../../utils/draft-revision.js';
import { localizeArticleMediaRefs, carriesDepthFreeMediaRef } from '../../utils/media-body-refs.js';
import { isLocalFileUnmodified } from '../baseline-reconstruction.js';
import { computeTaxonomyHash } from '../terms.js';
import {
  calculateHash,
  commitArticleSnapshot,
  resolveCanonicalArticlePath,
} from '../workspace/index.js';
import { extractCanonicalRemoteTitle } from './list.js';
import { mirrorArticleReferencedMedia } from './media_stage.js';
import type { FastPathContext, PullOptions, PullResult } from './types.js';

/**
 * Tests the fast-path for an article pull:
 * - Unmodified differential skip (0-GET when rawItem is provided and remote _rev matches cached rev)
 * - Legacy depth-free media ref re-spelling
 * - Non-destructive frontmatter syntax healing while preserving unpushed local body edits
 */
export async function tryFastPathOrHeal(
  ctx: FastPathContext,
  item: Record<string, unknown>,
): Promise<PullResult | null> {
  const {
    collection,
    id,
    options,
    fetchAssignedTerms,
    getBylineIdToSlug,
    getTaxonomyCandidates,
    localizeDiskMarkdown,
  } = ctx;

  if (options.force) return null;
  const existingSync = options.cache.getSyncState(id);
  const rawObj = (item.rawItem || item) as Record<string, unknown>;
  const rawRevCandidate = String(item._rev || item.rev || item.version || rawObj._rev || '');
  const remoteRev = extractRev(rawObj, rawRevCandidate);
  const remoteComparisonRev = extractComparisonRev(rawObj, remoteRev);

  if (!existingSync || !remoteRev || !isSameRev(existingSync.remoteRev, remoteComparisonRev)) {
    return null;
  }

  const fullExistingPath = path.join(options.workspaceRoot, existingSync.localFilePath);
  if (!fs.existsSync(fullExistingPath)) {
    return null;
  }

  try {
    const currentDiskContent = fs.readFileSync(fullExistingPath, 'utf8');
    // `sync_state.local_hash` always tracks the exact bytes on disk, so a workspace that spells mirrored
    // images as local references must be compared against the same spelling — not against the canonical
    // remote form. Reconstructing the expected disk content keeps the fast-path skip honest under both
    // settings and prevents a phantom "modified" for an article nothing changed.
    const currentDiskHash = calculateHash(currentDiskContent);

    // Check if file path matches current naming standard
    const existingPrefix = extractDatePrefixFromPath(existingSync.localFilePath);
    const fallbackSlug = String(item.slug || existingSync.slug || '');
    const rawTitle = extractCanonicalRemoteTitle(rawObj, fallbackSlug);
    const targetStatus = String(rawObj.status || item.status || 'draft');
    const expectedRelPath = resolveCanonicalArticlePath(
      collection,
      targetStatus,
      id,
      rawTitle,
      {
        publishedAt: (rawObj.publishedAt as string) || (item.publishedAt as string) || null,
        createdAt: (rawObj.createdAt as string) || (item.createdAt as string) || null,
        updatedAt: (rawObj.updatedAt as string) || (item.updatedAt as string) || null,
      },
      existingPrefix,
    );

    // If path matches and contents are unchanged, safely skip (only if local frontmatter is valid YAML)
    if (existingSync.localFilePath === expectedRelPath) {
      // A workspace built before article-relative refs carries the depth-free `media/<storageKey>` spelling,
      // and its tracked hash records exactly those bytes. Repairing the spelling here — rather than falling
      // through to a full remote re-pull — keeps the skip honest: the content is untouched, only the reference
      // form advances, and the file re-tracks against its own repaired hash so nothing reports a phantom edit.
      if (
        options.localMediaRefs &&
        currentDiskHash === existingSync.localHash &&
        carriesDepthFreeMediaRef(currentDiskContent)
      ) {
        const respelled = localizeArticleMediaRefs(currentDiskContent, {
          workspaceRoot: options.workspaceRoot,
          articleRelPath: existingSync.localFilePath,
          fs,
        });
        if (respelled !== currentDiskContent) {
          try {
            parseMarkdown(respelled);
            fs.writeFileSync(fullExistingPath, respelled, 'utf8');
            retrackLocalHashOnly(options.cache, {
              id,
              diskContent: respelled,
              touchSyncedAt: true,
            });
            return {
              id,
              slug: existingSync.slug,
              status: existingSync.status,
              filePath: existingSync.localFilePath,
              updated: true,
              healed: true,
              meaningChanged: false,
              title: rawTitle,
            };
          } catch {
            // Re-spelling broke the parse (it should not): fall through to the normal paths untouched.
          }
        }
      }

      const isUnmodified =
        currentDiskHash === existingSync.localHash ||
        isLocalFileUnmodified({
          workspaceRoot: options.workspaceRoot,
          cache: options.cache,
          id,
          relPath: existingSync.localFilePath,
          localContent: currentDiskContent,
          syncState: existingSync,
          candidates: getTaxonomyCandidates(),
          healOnSpellingMatch: false,
        });

      if (isUnmodified) {
        try {
          const parsedCurrent = parseMarkdown(currentDiskContent);

          let mediaSummary = undefined;
          if (options.mediaSync !== false) {
            mediaSummary = await mirrorArticleReferencedMedia(
              options,
              currentDiskContent,
              parsedCurrent.frontmatter.featuredImage,
            );
          }

          // Check if local relative pathing can be healed now that media is mirrored
          if (options.localMediaRefs) {
            const localized = localizeDiskMarkdown(currentDiskContent, existingSync.localFilePath);
            if (localized !== currentDiskContent) {
              const fullDiskPath = path.resolve(options.workspaceRoot, existingSync.localFilePath);
              fs.writeFileSync(fullDiskPath, localized, 'utf8');
              retrackLocalHashOnly(options.cache, {
                id,
                diskContent: localized,
                touchSyncedAt: true,
              });
              return {
                id,
                slug: existingSync.slug,
                status: existingSync.status,
                filePath: existingSync.localFilePath,
                updated: true,
                healed: true,
                meaningChanged: false,
                title: rawTitle,
                media: mediaSummary,
              };
            }
          }

          // Branch 1: Valid YAML on hash-matched untouched file, but carries percent-encoded taxonomy terms or out-of-sync draft revision annotation -> heal in-place
          const hasDraft = hasUncommittedDraftRevision(existingSync);
          const carriesDraftComment = /^\s*status:\s*published\s+#\s*draft revision\s*$/m.test(
            currentDiskContent,
          );
          const needsDraftRevisionHeal =
            parsedCurrent.frontmatter.status === 'published' && hasDraft !== carriesDraftComment;

          if (carriesPercentEncodedTaxonomy(currentDiskContent) || needsDraftRevisionHeal) {
            const respelledCanon = serializeMarkdown(
              parsedCurrent.frontmatter,
              parsedCurrent.body,
              getTaxonomyCandidates(),
              { hasDraftRevision: hasDraft },
            );
            const respelled = localizeDiskMarkdown(respelledCanon, existingSync.localFilePath);
            if (respelled !== currentDiskContent) {
              try {
                parseMarkdown(respelled);
                commitArticleSnapshot(options.cache, options.workspaceRoot, {
                  id,
                  relPath: existingSync.localFilePath,
                  diskContent: respelled,
                  canonicalContent: respelledCanon,
                  frontmatter: parsedCurrent.frontmatter,
                  bodyMarkdown: parsedCurrent.body,
                  revForTransport: existingSync.remoteRev,
                  revForComparison: existingSync.remoteRev,
                  bumpBaselineHashOnly: true,
                });
                return {
                  id,
                  slug: existingSync.slug,
                  status: existingSync.status,
                  filePath: existingSync.localFilePath,
                  updated: true,
                  healed: true,
                  meaningChanged: false,
                  title: rawTitle,
                  media: mediaSummary,
                };
              } catch {
                // Re-spelling broke the parse (should not happen): fall through to skip
              }
            }
          }

          if (currentDiskHash !== existingSync.localHash) {
            retrackLocalHashOnly(options.cache, {
              id,
              diskContent: currentDiskContent,
              touchSyncedAt: true,
            });
          }

          return {
            id,
            slug: existingSync.slug,
            status: existingSync.status,
            filePath: existingSync.localFilePath,
            updated: false,
            skipped: true,
            title: rawTitle,
            media: mediaSummary,
          };
        } catch {
          // Branch 2: Broken YAML on hash-matched untouched file.
          // Heal syntax via lenient repair, then serialize cleanly to decoded representation with zero network fetches.
          const repaired = lenientRepairMarkdownFrontmatter(currentDiskContent);
          if (repaired !== null) {
            const parsedRepaired = parseMarkdown(repaired);
            const hasDraft = hasUncommittedDraftRevision({
              status: parsedRepaired.frontmatter.status,
              remoteRev: remoteComparisonRev,
            });
            const decodedCanon = serializeMarkdown(
              parsedRepaired.frontmatter,
              parsedRepaired.body,
              getTaxonomyCandidates(),
              { hasDraftRevision: hasDraft },
            );
            const decodedDisk = localizeDiskMarkdown(decodedCanon, existingSync.localFilePath);
            commitArticleSnapshot(options.cache, options.workspaceRoot, {
              id,
              relPath: existingSync.localFilePath,
              diskContent: decodedDisk,
              frontmatter: parsedRepaired.frontmatter,
              bodyMarkdown: parsedRepaired.body,
              revForTransport: remoteRev,
              revForComparison: remoteComparisonRev,
              bumpBaselineHashOnly: true,
            });

            return {
              id,
              slug: parsedRepaired.frontmatter.slug,
              status: parsedRepaired.frontmatter.status,
              filePath: existingSync.localFilePath,
              updated: true,
              healed: true,
              meaningChanged: false,
              title: rawTitle,
            };
          }
          // Not healable locally: fall through to the full remote pull, which re-serializes canonical
          // frontmatter from the API response and quarantines any body that diverged from the baseline.
        }
      }

      // Local file has unpushed edits. Check if frontmatter parses cleanly.
      try {
        parseMarkdown(currentDiskContent);
        return {
          id,
          slug: existingSync.slug,
          status: existingSync.status,
          filePath: existingSync.localFilePath,
          updated: false,
          skipped: true,
          localEditsPreserved: true,
          title: rawTitle,
        };
      } catch {
        // Local frontmatter is invalid. Attempt non-destructive lenient frontmatter repair.
        const repaired = lenientRepairMarkdownFrontmatter(currentDiskContent);
        if (repaired !== null) {
          fs.writeFileSync(fullExistingPath, repaired, 'utf8');
          const parsedRepaired = parseMarkdown(repaired);

          const resolvedBylineMap = await getBylineIdToSlug();
          const effectiveOptions: PullOptions = {
            ...options,
            bylineIdToSlug: resolvedBylineMap,
          };
          const remoteLocal = apiResponseToLocal(rawObj, effectiveOptions);
          const [categoriesTerms, tagsTerms] = await Promise.all([
            fetchAssignedTerms('category'),
            fetchAssignedTerms('tag'),
          ]);

          if (categoriesTerms !== null || tagsTerms !== null) {
            if (!remoteLocal.frontmatter.taxonomies) {
              remoteLocal.frontmatter.taxonomies = {};
            }
            if (categoriesTerms !== null) {
              remoteLocal.frontmatter.taxonomies.categories = categoriesTerms;
            }
            if (tagsTerms !== null) {
              remoteLocal.frontmatter.taxonomies.tags = tagsTerms;
            }
          }

          const hasDraft = hasUncommittedDraftRevision({
            status: remoteLocal.frontmatter.status,
            remoteRev: remoteComparisonRev,
          });
          const remoteCanonMarkdown = serializeMarkdown(
            remoteLocal.frontmatter,
            remoteLocal.body,
            getTaxonomyCandidates(),
            { hasDraftRevision: hasDraft },
          );
          // The repaired file on disk carries the workspace's local-media-ref spelling, so the tracked hash
          // must be the hash of that spelling. The baseline keeps the canonical form untouched.
          const remoteDiskHash = calculateHash(
            localizeDiskMarkdown(remoteCanonMarkdown, existingSync.localFilePath, true),
          );

          const existingBase = options.cache.getBaseSnapshot(id);
          const bumpBaselineHashOnly = Boolean(
            categoriesTerms === null && tagsTerms === null && existingBase,
          );
          commitArticleSnapshot(options.cache, options.workspaceRoot, {
            id,
            relPath: existingSync.localFilePath,
            diskContent: repaired,
            localHash: remoteDiskHash,
            canonicalContent: remoteCanonMarkdown,
            frontmatter: remoteLocal.frontmatter,
            bodyMarkdown: remoteLocal.body,
            revForTransport: remoteRev,
            revForComparison: remoteComparisonRev,
            bumpBaselineHashOnly,
            skipDiskWrite: true,
            flags: {
              remoteTaxonomyHash: computeTaxonomyHash(
                remoteLocal.frontmatter.taxonomies?.categories,
                remoteLocal.frontmatter.taxonomies?.tags,
              ),
              taxonomyApplyPending: 0,
              conflictPending: existingSync.conflictPending,
              bodyConflictPending: existingSync.bodyConflictPending,
              taxonomyConflictPending: existingSync.taxonomyConflictPending,
              conflictCopyPath: existingSync.conflictCopyPath,
              conflictCopyHash: existingSync.conflictCopyHash,
              conflictAt: existingSync.conflictAt,
            },
          });

          return {
            id,
            slug: parsedRepaired.frontmatter.slug,
            status: parsedRepaired.frontmatter.status,
            filePath: existingSync.localFilePath,
            updated: true,
            healed: true,
            meaningChanged: false,
            title: rawTitle,
          };
        }
      }
    }
  } catch {
    // If error, fall through to full pull
  }

  return null;
}

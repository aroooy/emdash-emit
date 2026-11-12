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

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextResolver, ServerContext } from '../context.js';
import { pullArticle, formatQuarantineNotice, type PullResult } from '../../sync/pull.js';
import { pullBatch } from '../../sync/orchestrator.js';
import {
  pullTaxonomies,
  getLocalTaxonomiesSummary,
  formatTaxonomiesHint,
} from '../../sync/taxonomies.js';
import { pullMedia } from '../../sync/media.js';
import { formatMediaCoverageLine, formatOrphanMediaWarning } from '../../cli/commands/pull.js';
import { resolveArticleTarget } from '../../sync/diff.js';
import { compareArticleFilenameDesc } from '../../utils/naming.js';
import { formatToolError } from '../tool-errors.js';
import { DEFAULT_CONFIG } from '../../utils/config.js';

export function registerSyncPullTools(server: McpServer, resolveContext: ContextResolver): void {
  // sync_pull: Pull remote article(s) and taxonomies
  server.tool(
    'sync_pull',
    'Pull remote articles and taxonomies from EmDash into local Markdown files (posts/published/ and posts/draft/) and YAML taxonomy definitions (categories/ and tags/). Batch mode automatically syncs categories and tags alongside articles and returns available taxonomy hints (also shown with postsOnly:true). Use postsOnly:true to skip taxonomies. Use includeMedia:true for an additional bounded media-library pass (mediaSyncLimit, default 300) — referenced images in pulled articles are already mirrored on-demand without it. Supports pulling a single article by id/filePath. After pulling, ALWAYS read and edit the local Markdown files directly with standard file tools.',
    {
      collection: z.string().optional().describe('Collection name to pull (defaults to "posts")'),
      id: z.string().optional().describe('Specific article ID to pull'),
      filePath: z
        .string()
        .optional()
        .describe('Specific article file path (relative to workspace root) to pull'),
      status: z
        .enum(['all', 'draft', 'published'])
        .optional()
        .describe('Filter articles by status (batch mode, defaults to "all")'),
      force: z
        .boolean()
        .optional()
        .describe('Force overwrite local files and bypass differential hash checking'),
      localMediaRefs: z
        .boolean()
        .optional()
        .describe(
          'Write mirrored body images as article-relative "../../media/<storageKey>" references so Markdown preview resolves them locally. Defaults to the workspace setting in .emit/config.json.',
        ),
      noPrune: z
        .boolean()
        .optional()
        .describe(
          'Escape hatch: do not prune local articles outside the sync window (not needed for routine use)',
        ),
      prune: z
        .boolean()
        .optional()
        .describe('Explicitly control whether to prune articles outside the sync window'),
      postsOnly: z
        .boolean()
        .optional()
        .describe('Skip taxonomy (categories/tags) sync. Pull articles only.'),
      includeMedia: z
        .boolean()
        .optional()
        .describe(
          'Also pull media assets and companion metadata into media/ (bounded by mediaSyncLimit, default 300; referenced media in pulled articles is mirrored on-demand automatically without this flag).',
        ),
      metadataOnly: z
        .boolean()
        .optional()
        .describe('With includeMedia: download only metadata YAML, skip binary file downloads.'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      let ctx: ServerContext;
      try {
        ctx = resolveContext(args.profile);
      } catch (error) {
        return formatToolError(error);
      }
      const collection = args.collection || ctx.config.defaultCollection;
      const origin = ctx.origin;
      // An explicit MCP argument wins over the remembered workspace setting, matching the CLI flag precedence.
      const localMediaRefs =
        args.localMediaRefs === undefined ? ctx.config.localMediaRefs : args.localMediaRefs;

      const { id: targetId } = resolveArticleTarget({
        workspaceRoot: ctx.root,
        filePath: args.filePath,
        id: args.id,
      });

      if (targetId) {
        let res: PullResult;
        try {
          if (!args.postsOnly) {
            await pullTaxonomies({
              workspaceRoot: ctx.root,
              origin,
              token: ctx.auth.token,
              refreshToken: ctx.auth.refreshToken,
            }).catch(() => null);
          }
          res = await pullArticle(collection, targetId, {
            workspaceRoot: ctx.root,
            cache: ctx.cache,
            origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            force: args.force,
            localMediaRefs,
          });
        } catch (error) {
          return formatToolError(error);
        }

        const actionText = res.healed
          ? '🛠️ Repaired frontmatter syntax (unpushed local body was strictly preserved)'
          : res.localEditsPreserved
            ? 'ℹ️ Local edits preserved (remote changes were NOT applied)'
            : res.skipped
              ? 'ℹ️ Article is already up-to-date'
              : '✅ Successfully pulled article';
        const titleText = res.title ? ` "${res.title}"` : '';
        const warnLine = ctx.originWarning ? `\n\n${ctx.originWarning}` : '';
        const quarantineNotice = formatQuarantineNotice(res.quarantined);
        const quarantineLine = quarantineNotice ? `\n\n${quarantineNotice}` : '';
        const nextStep = res.localEditsPreserved
          ? '\n\nYour local version is intact. Push it with sync_push to publish your edits, ' +
            'or re-run sync_pull with force: true to accept the remote version instead.'
          : '\n\nYou can now read or edit this local Markdown file directly.';

        const metaSuffix = `\n\n_meta: ${JSON.stringify(ctx.meta)}`;
        return {
          content: [
            {
              type: 'text',
              text: `${actionText}${titleText} (${res.slug})\nFile path: ${res.filePath}\nStatus: ${res.status}${quarantineLine}${warnLine}${nextStep}${metaSuffix}`,
            },
          ],
        };
      }

      // Batch sync mode: taxonomies + articles (+ media if includeMedia)
      const limit =
        ctx.config.postsSyncLimit || ctx.config.syncLimit || DEFAULT_CONFIG.postsSyncLimit;
      const shouldPrune = args.prune !== undefined ? args.prune : args.noPrune ? false : undefined;
      const postsOnly = args.postsOnly === true;
      const includeMedia = args.includeMedia === true;

      try {
        // 1. Pull taxonomies (unless postsOnly or single-article mode)
        let taxonomiesMsg = '';
        if (!postsOnly) {
          const taxResult = await pullTaxonomies({
            workspaceRoot: ctx.root,
            origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
          });
          const failNotes: string[] = [];
          if (taxResult.categoriesFailed) failNotes.push('categories');
          if (taxResult.tagsFailed) failNotes.push('tags');
          if (failNotes.length > 0) {
            taxonomiesMsg = `\n⚠️ Taxonomies: Failed to fetch remote ${failNotes.join(' and ')} (preserved existing local definitions).`;
          } else {
            taxonomiesMsg = `\nTaxonomies: ${taxResult.categoriesCount} categories, ${taxResult.tagsCount} tags synced.`;
          }
        }

        const taxSummary = getLocalTaxonomiesSummary(ctx.root);
        const taxHint = formatTaxonomiesHint(taxSummary, { maxTags: 60 });
        if (taxHint) {
          taxonomiesMsg += `\n\n${taxHint}`;
        }

        // 2. Pull articles
        const batchResult = await pullBatch({
          collection,
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          limit,
          status: args.status,
          force: args.force,
          prune: shouldPrune,
          localMediaRefs,
          // Local-first media mirroring is default-ON for a batch pull; postsOnly skips it, matching the CLI.
          mediaSync: !postsOnly,
        });

        const deletedMsg = batchResult.deleted ? `, ${batchResult.deleted} pruned` : '';
        // Sort items descending by filename (YYYYMMDD_ prefix / ULID) so newest articles appear first
        const sortedItems = [...batchResult.items].sort((a, b) =>
          compareArticleFilenameDesc(a.filePath, b.filePath),
        );
        const updatedItems = sortedItems.filter((i) => i.updated);
        const sampleItems = (updatedItems.length > 0 ? updatedItems : sortedItems).slice(0, 10);
        const listLines = sampleItems.map(
          (item) => `  - [${item.status}] ${item.filePath}${item.title ? ` (${item.title})` : ''}`,
        );
        const headerLabel =
          updatedItems.length > 0 ? 'Updated Articles' : 'Recent Articles in Workspace';
        const detailBlock =
          listLines.length > 0 ? `\n\n${headerLabel}:\n${listLines.join('\n')}` : '';

        const preservedMsg =
          batchResult.preserved && batchResult.preserved > 0
            ? `\n🛡️ ${batchResult.preserved} article(s) had unpushed local edits; Emit kept your local version (remote changes were NOT applied). Push them with sync_push, or re-run with force: true to accept the remote version instead.`
            : '';

        const quarantineNotices = sortedItems
          .map((item) => formatQuarantineNotice(item.quarantined))
          .filter((notice) => notice.length > 0);
        const quarantineMsg =
          quarantineNotices.length > 0 ? `\n\n${quarantineNotices.join('\n\n')}` : '';

        // 3. Pull media if includeMedia
        let mediaMsg = '';
        if (batchResult.media) {
          const m = batchResult.media;
          const totalLabel =
            typeof m.remoteTotalCount === 'number' && m.remoteTotalCount > 0
              ? `${m.walkedCount}/${m.remoteTotalCount}`
              : `${m.walkedCount}${m.complete ? '' : '+'}`;
          mediaMsg += `\nMedia (local-first): walked ${totalLabel} record(s), mirrored ${m.mirroredStorageKeys.length} referenced asset(s) (${m.downloaded} downloaded, ${m.skipped} up-to-date).`;
          const orphanWarning = formatOrphanMediaWarning(m.orphanStorageKeys);
          if (orphanWarning) mediaMsg += `\n${orphanWarning}`;
        }
        if (includeMedia) {
          const mediaLimit = ctx.config.mediaSyncLimit || DEFAULT_CONFIG.mediaSyncLimit;
          const mediaResult = await pullMedia({
            workspaceRoot: ctx.root,
            origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            limit: mediaLimit,
            downloadFiles: args.metadataOnly !== true,
            cache: ctx.cache,
          });
          mediaMsg += `\nMedia (library pass, limit ${mediaLimit}): ${mediaResult.total} items (${mediaResult.downloaded} downloaded, ${mediaResult.skipped} up-to-date).`;
        }

        const warnLine = ctx.originWarning ? `\n\n${ctx.originWarning}` : '';
        const metaSuffix = `\n\n_meta: ${JSON.stringify(ctx.meta)}`;
        return {
          content: [
            {
              type: 'text',
              text: `✅ Synced ${batchResult.total} articles (${batchResult.updated} updated, ${batchResult.skipped} up-to-date/skipped${deletedMsg}).${taxonomiesMsg}${mediaMsg}${preservedMsg}${quarantineMsg}${detailBlock}${warnLine}${metaSuffix}\n\nYou can now read or edit these local Markdown files directly.`,
            },
          ],
        };
      } catch (error) {
        return formatToolError(error, ctx?.meta);
      }
    },
  );

  // sync_pull_taxonomies
  server.tool(
    'sync_pull_taxonomies',
    'Pull remote categories and tags into local YAML definitions (categories/<id>-<name>.yaml and tags/<id>-<name>.yaml) and return formatted available categories/tags hints (up to 200 tags). Use before writing articles to inspect valid category and tag IDs/slugs.',
    {
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      try {
        const ctx = resolveContext(args.profile);
        const res = await pullTaxonomies({
          workspaceRoot: ctx.root,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
        });

        const taxSummary = getLocalTaxonomiesSummary(ctx.root);
        const taxHint = formatTaxonomiesHint(taxSummary, { maxTags: 200 });
        const hintBlock = taxHint ? `\n\n${taxHint}` : '';

        const failNotes: string[] = [];
        if (res.categoriesFailed) failNotes.push('categories');
        if (res.tagsFailed) failNotes.push('tags');
        const statusLine =
          failNotes.length > 0
            ? `⚠️ Warning: Failed to fetch remote ${failNotes.join(' and ')} (preserved existing local definitions in categories/ and tags/).`
            : `✅ Successfully pulled taxonomies (${res.categoriesCount} categories, ${res.tagsCount} tags) into categories/ and tags/.`;

        const metaSuffix = `\n\n_meta: ${JSON.stringify(ctx.meta)}`;
        return {
          content: [
            {
              type: 'text',
              text: `${statusLine}${hintBlock}${metaSuffix}`,
            },
          ],
        };
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  // sync_pull_media
  server.tool(
    'sync_pull_media',
    'Download remote media assets and companion YAML metadata into the local media/ directory (media/<markdownRef>.<ext> and .yaml, where markdownRef is derived from the storageKey a body URL references). Can pull targeted media referenced by an article ("article"), a specific storageKey ("storageKey"), or the full library ("all", maintenance/backup only). Note: Routine workflows rarely need this tool because sync_pull mirrors referenced assets on-demand automatically. Body image references that match neither a media record nor confirmed local mirror metadata are reported as orphanStorageKeys and never downloaded.',
    {
      article: z
        .string()
        .optional()
        .describe(
          'Target article ULID or Markdown file path to pull only media referenced by that article',
        ),
      storageKey: z
        .string()
        .optional()
        .describe(
          'Target a specific storageKey to mirror individually (e.g. chosen from sync_media_search)',
        ),
      collection: z
        .string()
        .optional()
        .describe('Collection name when using article (defaults to "posts")'),
      limit: z
        .number()
        .optional()
        .describe(
          'Maximum number of media items to pull (defaults to 300; bounded batch, routine workflows mirror referenced assets on-demand automatically)',
        ),
      all: z
        .boolean()
        .optional()
        .describe(
          'Maintenance/backup only (⚠️ NOT for routine use). Pull ALL media binaries from remote (can download thousands of files). Routine workflows do not need this because sync_pull mirrors referenced assets automatically. Reserve strictly for complete offline backups or migration diagnostics (defaults to false).',
        ),
      downloadFiles: z.boolean().optional().describe('Download binary files (defaults to true)'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      try {
        const ctx = resolveContext(args.profile);
        const metaSuffix = `\n\n_meta: ${JSON.stringify(ctx.meta)}`;

        if (args.storageKey) {
          const res = await pullMedia({
            workspaceRoot: ctx.root,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            storageKeys: [args.storageKey],
            downloadFiles: args.downloadFiles,
            cache: ctx.cache,
          });

          const orphanWarning = formatOrphanMediaWarning(res.orphanStorageKeys);
          if (res.total === 0 && res.orphanStorageKeys && res.orphanStorageKeys.length > 0) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `❌ Could not resolve targeted storageKey '${args.storageKey}' on remote.${orphanWarning ? `\n\n${orphanWarning}` : ''}${metaSuffix}`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: `✅ Successfully pulled targeted media asset '${args.storageKey}': ${res.total} items (${res.downloaded} downloaded, ${res.skipped} skipped/up-to-date).${orphanWarning ? `\n\n${orphanWarning}` : ''}${metaSuffix}`,
              },
            ],
          };
        }

        const res = await pullMedia({
          workspaceRoot: ctx.root,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          article: args.article,
          collection: args.collection || ctx.config.defaultCollection,
          limit: args.limit || ctx.config.mediaSyncLimit || DEFAULT_CONFIG.mediaSyncLimit,
          all: args.all,
          downloadFiles: args.downloadFiles,
          cache: ctx.cache,
        });

        const orphanWarning = formatOrphanMediaWarning(res.orphanStorageKeys);
        if (args.article) {
          const failedMsg = res.failed ? `, ${res.failed} unresolved` : '';
          const verifiedCount = res.verifiedStorageKeys?.length ?? 0;
          const verifiedMsg = verifiedCount > 0 ? `, ${verifiedCount} verified/mirrored` : '';
          const idNote =
            res.unresolvedIds && !res.failed
              ? ` (${res.unresolvedIds} body ULID(s) are R2 storageKeys, not media record ids, so no id lookup was expected to match)`
              : '';
          const idsList =
            res.mediaIds && res.mediaIds.length > 0
              ? `\nMedia IDs: ${res.mediaIds.join(', ')}`
              : '';
          const keysList =
            res.orphanStorageKeys && res.orphanStorageKeys.length > 0
              ? `\nUnresolved Storage Keys (no matching record or local mirror): ${res.orphanStorageKeys.join(', ')}`
              : '';
          return {
            content: [
              {
                type: 'text',
                text: `✅ Successfully pulled media for article '${res.articleId || args.article}': ${res.total} referenced item(s) (${res.downloaded} downloaded, ${res.skipped} skipped/up-to-date${verifiedMsg}${failedMsg}).${idNote}${idsList}${keysList}${orphanWarning ? `\n\n${orphanWarning}` : ''}${metaSuffix}`,
              },
            ],
          };
        }

        const deletedMsg = res.deleted ? `, ${res.deleted} pruned` : '';
        return {
          content: [
            {
              type: 'text',
              text: `✅ Successfully pulled media: ${res.total} items (${res.downloaded} downloaded, ${res.skipped} skipped/up-to-date${deletedMsg}).${formatMediaCoverageLine(res)}${metaSuffix}`,
            },
          ],
        };
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}

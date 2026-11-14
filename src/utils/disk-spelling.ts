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
import { carriesPercentEncodedTaxonomy } from './frontmatter.js';
import { carriesDepthFreeMediaRef, localizeArticleMediaRefs } from './media-body-refs.js';
import { hasUncommittedDraftRevision } from './draft-revision.js';

export interface DiskSpelling {
  preferEncodedTaxonomy: boolean;
  preferLegacyMediaRef: boolean;
  hasDraftRevision: boolean;
}

/**
 * Derives the active disk spelling dimensions across all 3 representation axes:
 * 1. taxonomy encoding (decoded vs percent-encoded)
 * 2. media references (article-relative vs depth-free legacy)
 * 3. draft revision (clean published vs uncommitted draft revision)
 */
export function resolveDiskSpelling(
  diskContent: string,
  syncState?: { remoteRev?: string | null; status?: string | null } | null,
): DiskSpelling {
  return {
    preferEncodedTaxonomy: carriesPercentEncodedTaxonomy(diskContent),
    preferLegacyMediaRef: carriesDepthFreeMediaRef(diskContent),
    hasDraftRevision: hasUncommittedDraftRevision(syncState),
  };
}

/**
 * Converts canonical Markdown into the exact disk spelling for the workspace.
 * Ensures consistent serialization between pull, commit, diff, and status.
 */
export function renderForDisk(
  canonicalContent: string,
  spelling: DiskSpelling,
  ctx: {
    workspaceRoot: string;
    articleRelPath: string;
    fs?: typeof fs;
  },
): string {
  return localizeArticleMediaRefs(canonicalContent, {
    workspaceRoot: ctx.workspaceRoot,
    articleRelPath: ctx.articleRelPath,
    fs: ctx.fs || fs,
    preferLegacyRef: spelling.preferLegacyMediaRef,
  });
}

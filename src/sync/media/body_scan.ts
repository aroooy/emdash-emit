import yaml from 'js-yaml';
import { extractMediaUlid } from '../../client/mapper.js';
import { parseMarkdown, lenientRepairMarkdownFrontmatter } from '../../utils/frontmatter.js';
import { scanArticleMediaReferences } from '../../utils/media-body-refs.js';
import { toStorageKey } from '../../utils/media-id.js';
import type { OrphanMediaDescriptor } from './types.js';

/** Builds a descriptor from a ULID-segment storageKey, defaulting to `.jpg` when no extension is present. */
function descriptorFromStorageKey(storageKey: string): OrphanMediaDescriptor | null {
  const key = toStorageKey(storageKey);
  if (!key) return null;
  const extMatch = storageKey.match(/\.[a-z]+$/i);
  return {
    storageKey: key,
    ext: extMatch ? extMatch[0].toLowerCase() : '.jpg',
    ulids: Array.from(storageKey.matchAll(/[0-9A-HJ-NP-Z]{26}/gi), (m) => m[0].toUpperCase()),
  };
}

/** Collapses descriptors that name the same storageKey, keeping one entry per key. */
function dedupeDescriptorsByStorageKey(
  descriptors: OrphanMediaDescriptor[],
): OrphanMediaDescriptor[] {
  const byKey = new Map<string, OrphanMediaDescriptor>();
  for (const descriptor of descriptors) {
    if (!byKey.has(descriptor.storageKey)) byKey.set(descriptor.storageKey, descriptor);
  }
  return Array.from(byKey.values()).sort((a, b) => a.storageKey.localeCompare(b.storageKey));
}

/**
 * Extracts every media file storageKey referenced by an article (markdown images, HTML img tags,
 * opaque custom-block fences, and legacy container lines such as `[dimage url="..." control=true]`).
 * A storageKey must be ULID-segment based with a known image extension, so template placeholders
 * (`<storageKey>`) and prose never produce descriptors. The media record id is deliberately NOT
 * inferred from it: for migrated WordPress assets the file route serves `<storageKey>` while the
 * record id returns 404, so only the storageKey can be reported to the user.
 */
export function collectArticleStorageKeys(content: string): OrphanMediaDescriptor[] {
  const keys = new Set<string>();
  const keyPattern =
    /(?:^|\/)media\/file\/([0-9A-HJ-NP-Z]{26}(?:\.[0-9A-HJ-NP-Z]{26})*\.(?:jpg|jpeg|png|gif|webp|avif|svg))/gi;
  // A workspace that spells a mirrored image as `media/<storageKey>` names the key outright rather than
  // through the file route, so the census must read that spelling too — otherwise an unmirrored local
  // reference silently disappears from `referencedUnmirroredStorageKeys`.
  const localRefPattern =
    /(?:^|\/)media\/([0-9A-HJ-NP-Z]{26}(?:\.[0-9A-HJ-NP-Z]{26})*\.(?:jpg|jpeg|png|gif|webp|avif|svg))/gi;

  const harvest = (text: string, pattern: RegExp): void => {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      keys.add(match[1]);
    }
  };

  // scanArticleMediaReferences covers markdown images and HTML img tags anywhere in the body,
  // including inside opaque fences and legacy container lines where doctor stays quiet by design.
  const scannedRefs = scanArticleMediaReferences(content).join('\n');
  harvest(scannedRefs, keyPattern);
  harvest(content, keyPattern);
  harvest(scannedRefs, localRefPattern);
  harvest(content, localRefPattern);

  const descriptors: OrphanMediaDescriptor[] = [];
  for (const storageKey of keys) {
    const desc = descriptorFromStorageKey(storageKey);
    if (desc) descriptors.push(desc);
  }
  return dedupeDescriptorsByStorageKey(descriptors);
}

/**
 * Collects all media ULIDs referenced by an article content (frontmatter featuredImage + body images).
 */
export function collectArticleReferencedMediaIds(content: string): string[] {
  const ids = new Set<string>();

  let frontmatter: Record<string, unknown> | null = null;
  let body = content;

  // Try extracting YAML block directly if present
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (fmMatch) {
    try {
      frontmatter = (yaml.load(fmMatch[1]) as Record<string, unknown>) || null;
      body = content.slice(fmMatch[0].length);
    } catch {
      // Keep going
    }
  }

  if (!frontmatter) {
    try {
      const parsed = parseMarkdown(content);
      frontmatter = parsed.frontmatter as unknown as Record<string, unknown>;
      body = parsed.body;
    } catch {
      try {
        const healed = lenientRepairMarkdownFrontmatter(content);
        if (healed) {
          const parsed = parseMarkdown(healed);
          frontmatter = parsed.frontmatter as unknown as Record<string, unknown>;
          body = parsed.body;
        }
      } catch {
        // Fallback: search raw content
      }
    }
  }

  // 1. Frontmatter featuredImage
  if (frontmatter && frontmatter.featuredImage) {
    const ulid = extractMediaUlid(frontmatter.featuredImage);
    if (ulid) {
      ids.add(ulid);
    }
  } else {
    // Regex fallback for featuredImage in raw text if YAML parsing failed
    const rawFiMatch = content.match(/featuredImage:\s*["']?([0-9A-HJ-NP-Z]{26})["']?/i);
    if (rawFiMatch) {
      ids.add(rawFiMatch[1].toUpperCase());
    }
  }

  // 2. Body Markdown & HTML image references
  const refs = scanArticleMediaReferences(body);
  for (const ref of refs) {
    const ulid = extractMediaUlid(ref);
    if (ulid) {
      ids.add(ulid);
    } else {
      const match = ref.match(/(?:^|\/)(?:\d{8}_)?([0-9A-HJ-NP-Z]{26})-/i);
      if (match) {
        ids.add(match[1].toUpperCase());
      }
    }
  }

  // 3. URLs matching /_emdash/api/media/file/<ULID> or /media/<ULID>
  const mediaUrlRegex = /(?:\/media\/file\/|\/media\/)([0-9A-HJ-NP-Z]{26})/gi;
  let m: RegExpExecArray | null;
  while ((m = mediaUrlRegex.exec(body)) !== null) {
    ids.add(m[1].toUpperCase());
  }

  return Array.from(ids).sort();
}

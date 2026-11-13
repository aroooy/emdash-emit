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

/**
 * Centralized URL builders for EmDash REST API endpoints.
 * All functions strictly return string URLs.
 */

export function articleContentEndpoint(origin: string, collection: string, id?: string): string {
  const path = id
    ? `/_emdash/api/content/${collection}/${id}`
    : `/_emdash/api/content/${collection}`;
  return new URL(path, origin).toString();
}

export function articleStatusTransitionEndpoint(
  origin: string,
  collection: string,
  id: string,
  action: 'publish' | 'unpublish',
): string {
  return new URL(`/_emdash/api/content/${collection}/${id}/${action}`, origin).toString();
}

export function articleLockEndpoint(origin: string, collection: string, id: string): string {
  return new URL(`/_emdash/api/content/${collection}/${id}/lock`, origin).toString();
}

export function articleTermsEndpoint(
  origin: string,
  collection: string,
  id: string,
  taxonomy: string,
): string {
  return new URL(`/_emdash/api/content/${collection}/${id}/terms/${taxonomy}`, origin).toString();
}

export function taxonomiesTermsEndpoint(origin: string, taxonomy: string): string {
  return new URL(`/_emdash/api/taxonomies/${taxonomy}/terms`, origin).toString();
}

export function mediaDetailEndpoint(origin: string, mediaId: string): string {
  return new URL(`/_emdash/api/media/${mediaId}`, origin).toString();
}

/** Final stage of the 4-stage upload flow: `POST /_emdash/api/media/{mediaId}/confirm`. */
export function mediaConfirmEndpoint(origin: string, mediaId: string): string {
  return new URL(`/_emdash/api/media/${mediaId}/confirm`, origin).toString();
}

export function mediaListEndpoint(origin: string): string {
  return new URL('/_emdash/api/media', origin).toString();
}

export function mediaUploadUrlEndpoint(origin: string): string {
  return new URL('/_emdash/api/media/upload-url', origin).toString();
}

export function mediaFileEndpoint(origin: string, storageKey: string): string {
  return new URL(`/_emdash/api/media/file/${storageKey}`, origin).toString();
}

export function mcpEndpoint(origin: string): string {
  return new URL('/_emdash/api/mcp', origin).toString();
}

export function openApiEndpoint(origin: string): string {
  return new URL('/_emdash/api/openapi.json', origin).toString();
}

export function authTokenEndpoint(origin: string): string {
  return new URL('/_emdash/api/auth/token', origin).toString();
}

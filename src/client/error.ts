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
 * Structured API Error class representing failed EmDash API operations.
 * Carries HTTP status, internal error code, and actionable suggestions for user or AI recovery (G8).
 */
export class ApiError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly suggestion?: string;
  public readonly endpoint?: string;

  constructor(options: {
    message: string;
    code: string;
    status?: number;
    suggestion?: string;
    endpoint?: string;
  }) {
    super(options.message);
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status;
    this.suggestion = options.suggestion;
    this.endpoint = options.endpoint;

    // Maintains proper stack trace in V8 / Node.js
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApiError);
    }
  }

  /**
   * Formats the error into an actionable message suitable for console or MCP tool output.
   */
  public toActionableString(): string {
    const lines = [`❌ [${this.code}] ${this.message}`];
    if (this.status) lines.push(`   Status: HTTP ${this.status}`);
    if (this.endpoint) lines.push(`   Endpoint: ${this.endpoint}`);
    if (this.suggestion) lines.push(`   💡 Suggestion: ${this.suggestion}`);
    return lines.join('\n');
  }
}

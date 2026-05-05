/**
 * Rate-limit detector.
 *
 * Scans subprocess output (stdout/stderr) for usage/quota markers and tries to
 * extract an absolute reset time. Conservative: false-positive rate is kept
 * low because a spurious detection halts the entire run.
 */

export interface RateLimitHit {
  resetAt: number | null;
  source: string;
  raw: string;
}

const MARKER_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /quota.?exceeded/i,
  /usage[_ ]policy[_ ]violation/i,
  /\b429\b/,
  /too many requests/i,
  /usage limit reached/i,
];

const RETRY_AFTER_RE = /"retry_after"\s*:\s*(\d+)/i;
const RESET_SECONDS_RE = /"reset_seconds"\s*:\s*(\d+)/i;
const RESET_ISO_RE = /"reset"\s*:\s*"([0-9T:\-Z+.]+)"/i;

export function detectRateLimit(text: string): RateLimitHit | null {
  if (!text) return null;
  const matched = MARKER_PATTERNS.some((re) => re.test(text));
  if (!matched) return null;

  // Prefer explicit numeric retry_after over reset_seconds over ISO reset.
  const retryAfter = text.match(RETRY_AFTER_RE);
  if (retryAfter && retryAfter[1] !== undefined) {
    const secs = Number(retryAfter[1]);
    if (Number.isFinite(secs)) {
      return {
        resetAt: Date.now() + secs * 1000,
        source: 'json-retry-after',
        raw: text,
      };
    }
  }

  const resetSecs = text.match(RESET_SECONDS_RE);
  if (resetSecs && resetSecs[1] !== undefined) {
    const secs = Number(resetSecs[1]);
    if (Number.isFinite(secs)) {
      return {
        resetAt: Date.now() + secs * 1000,
        source: 'json-reset-seconds',
        raw: text,
      };
    }
  }

  const resetIso = text.match(RESET_ISO_RE);
  if (resetIso && resetIso[1] !== undefined) {
    const ms = Date.parse(resetIso[1]);
    if (Number.isFinite(ms)) {
      return {
        resetAt: ms,
        source: 'json-reset-iso',
        raw: text,
      };
    }
  }

  return { resetAt: null, source: 'stdout-marker', raw: text };
}

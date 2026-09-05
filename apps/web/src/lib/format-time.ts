/**
 * Shared timestamp formatting utility.
 *
 * Converts ISO 8601 timestamps (UTC) into human-readable relative time
 * ("5 min ago") or timezone-aware absolute dates for older items.
 *
 * Fixes the UTC parsing bug: backend sends ISO strings without a "Z" suffix,
 * which some browsers interpret as local time instead of UTC.
 */

/**
 * Format an ISO 8601 timestamp as relative time or an absolute date.
 *
 * @param isoString - ISO 8601 timestamp from the API (UTC, may lack "Z" suffix)
 * @param timezone  - IANA timezone (e.g. "Asia/Kuala_Lumpur"). Falls back to browser default.
 */
export function formatRelativeTime(
  isoString: string,
  timezone?: string | null,
): string {
  // Fix UTC parsing: backend returns "2026-02-18T12:34:56.789012" without "Z".
  // new Date() treats strings without timezone info inconsistently across browsers.
  // Append "Z" to force UTC interpretation when no timezone suffix exists.
  const normalized = isoString.match(/[Zz]$|[+-]\d{2}(:\d{2})?$/)
    ? isoString
    : isoString + "Z";

  const date = new Date(normalized);
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  // Relative time for recent items (timezone-agnostic — just ms diff)
  if (diffSeconds < 60) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  if (diffHours < 24)
    return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
  if (diffDays < 7)
    return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;

  // For older dates: timezone-aware absolute formatting
  const resolvedTz =
    timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: resolvedTz,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    // Fallback if timezone string is somehow invalid
    return date.toLocaleDateString();
  }
}

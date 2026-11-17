/**
 * Whether a scroll container shows its end, give or take `threshold` pixels.
 * The thread follows new content only while this holds, so a reader who
 * scrolled up to an older answer is not pulled back down.
 */
export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 48
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

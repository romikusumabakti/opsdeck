/** Relative luminance of an opaque oklch() colour (L as 0–1 or a percentage). */
export function luminance(value: string): number {
  const m = value.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!m?.[1] || !m[3] || !m[4])
    throw new Error(`not an opaque oklch(): ${value}`);
  const L = Number(m[1]) / (m[2] === "%" ? 100 : 1);
  const C = Number(m[3]);
  const H = (Number(m[4]) * Math.PI) / 180;
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  return (
    0.2126 * clip(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s) +
    0.7152 * clip(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s) +
    0.0722 * clip(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s)
  );
}

/** WCAG contrast ratio between two opaque oklch() colours. */
export function contrastRatio(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

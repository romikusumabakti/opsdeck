/**
 * Value-level redaction of personal identifiers in free text (service logs)
 * before it reaches the model provider (Stage 9 spec anti-goal: no personal
 * identifiers from a log). Pure module, no I/O. Best effort, tuned to keep
 * what a log needs to be read: timestamps, UUIDs, hashes, IP addresses,
 * ports and version numbers are never touched.
 *
 * Replaced, each by a `[redacted <kind>]` marker:
 * - email addresses;
 * - payment card numbers: 13 to 19 digits, plain or grouped by spaces or
 *   hyphens, that pass the Luhn check and start like a card (2 to 6);
 * - NIK: 16 digits whose province code, day (01-31, +40 for women) and month
 *   fields are plausible;
 * - NPWP: 15 digits (`12.345.678.9-012.345` or plain) or 16 digits starting
 *   with 0 (the 2024 form of an old NPWP), with or without punctuation;
 * - phone numbers: Indonesian mobiles (`08…`, `628…`, `+62 8…`), any `+62`
 *   number, and other `+` international numbers.
 */

export type PiiKind = "email" | "card" | "nik" | "npwp" | "phone";

const marker = (kind: PiiKind) => `[redacted ${kind}]`;

const EMAIL =
  /(?<![\w.%+-])[A-Za-z0-9][A-Za-z0-9._%+-]*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?![\w-])/g;

/** NPWP written with its punctuation: 99.999.999.9-999.999 (any of . - space). */
const NPWP_FORMATTED =
  /(?<![\w.-])\d{2}[. -]\d{3}[. -]\d{3}[. -]\d[. -]\d{3}[. -]\d{3}(?![\w]|[.-]\d)/g;

/**
 * Spans no rule may touch: UUIDs, hex hashes with a letter, ISO dates and
 * times, clock times, IPv4 addresses (with a port), version numbers.
 */
const PROTECTED = new RegExp(
  [
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.source,
    /(?<![\w])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}(?![\w])/.source,
    /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/
      .source,
    /\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?/.source,
    /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?![\w.])/.source,
    /(?<![\w.])v?\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.]+)?(?![\w.])/.source,
  ].join("|"),
  "gi"
);

/** A run of 13 to 19 digits, optionally grouped by single spaces or hyphens. */
const DIGIT_RUN = /(?<![\w.+/-])\d(?:[ -]?\d){12,18}(?![\w]|[.-]\d)/g;

const PHONE = new RegExp(
  [
    // Indonesian mobile: 08…, 628…, +62 8…; 10 to 14 digits in all.
    /(?<![\w.+/-])(?:\+62[ .-]?|62|0)8(?:[ .-]?\d){7,11}(?![\w]|[.-]\d)/.source,
    // Any +62 number (landlines: +62 21 5555 1234).
    /(?<![\w.+/-])\+62(?:[ .-]?\d){7,12}(?![\w]|[.-]\d)/.source,
    // Other international numbers, written without separators.
    /(?<![\w+])\+[1-9]\d{7,14}(?![\w])/.source,
  ].join("|"),
  "g"
);

/** Whether the digits pass the Luhn check. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Province codes (Kemendagri): Sumatra 11-19, Java 31-36, … Papua 91-96. */
const PROVINCE = /^(?:1[1-9]|21|3[1-6]|5[1-3]|6[1-5]|7[1-6]|8[12]|9[1-6])/;

/** NIK layout: province, regency, district, DDMMYY, serial. */
function plausibleNik(digits: string): boolean {
  const day = Number(digits.slice(6, 8));
  const month = Number(digits.slice(8, 10));
  const dayOk = (day >= 1 && day <= 31) || (day >= 41 && day <= 71);
  return PROVINCE.test(digits) && dayOk && month >= 1 && month <= 12;
}

/** What a digit run is, or null to leave it. */
function classifyDigits(run: string): PiiKind | null {
  const digits = run.replace(/[ -]/g, "");
  if (/^[2-6]/.test(digits) && luhnValid(digits)) return "card";
  if (digits.length === 16 && plausibleNik(digits)) return "nik";
  if (digits.length === 15) return "npwp";
  if (digits.length === 16 && digits.startsWith("0")) return "npwp";
  return null;
}

/** Numeric identifiers in text that holds no protected span. */
function redactNumbers(text: string, count: (n: number) => void): string {
  let out = text.replace(DIGIT_RUN, (run) => {
    const kind = classifyDigits(run);
    if (!kind) return run;
    count(1);
    return marker(kind);
  });
  out = out.replace(PHONE, () => {
    count(1);
    return marker("phone");
  });
  return out;
}

/** The text with personal identifiers replaced, and how many were. */
export function redactPii(text: string): { text: string; redacted: number } {
  let redacted = 0;
  const count = (n: number) => {
    redacted += n;
  };
  let out = text.replace(EMAIL, () => {
    count(1);
    return marker("email");
  });
  out = out.replace(NPWP_FORMATTED, () => {
    count(1);
    return marker("npwp");
  });
  // Numbers only between protected spans, so a rule never reads part of a
  // timestamp, UUID or address as an identifier.
  let result = "";
  let last = 0;
  for (const match of out.matchAll(PROTECTED)) {
    const start = match.index ?? 0;
    result += redactNumbers(out.slice(last, start), count) + match[0];
    last = start + match[0].length;
  }
  result += redactNumbers(out.slice(last), count);
  return { text: result, redacted };
}

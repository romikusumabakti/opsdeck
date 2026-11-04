import {
  createHash,
  createPublicKey,
  type KeyObject,
  timingSafeEqual,
  verify,
} from "node:crypto";

/**
 * Verifies the HTTP Message Signature (RFC 9421) Woodpecker puts on its
 * extension requests: ed25519 over `"@request-target"` and `"content-digest"`,
 * label `woodpecker-ci-extensions`, signed by github.com/yaronf/httpsign
 * (tests/fixtures/woodpecker-signed-request.json is a real one). The signature
 * covers the digest header, not the body, so the body is checked against
 * `Content-Digest` (RFC 9530) as well — a valid signature over a swapped body
 * must not pass.
 */

export const WOODPECKER_SIGNATURE_LABEL = "woodpecker-ci-extensions";

/** How far `created` may be from now, either way, in seconds. */
const MAX_SKEW_SECONDS = 300;

const REQUIRED_COMPONENTS = ["@request-target", "content-digest"] as const;

export type SignedRequest = {
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array;
};

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

function fail(reason: string): SignatureCheck {
  return { ok: false, reason };
}

/**
 * Split a Structured Fields dictionary (RFC 8941) into its raw members. Enough
 * for the three headers read here: commas inside quoted strings and inner
 * lists do not split, byte sequences carry no commas.
 */
function dictionaryMembers(value: string): Map<string, string> {
  const members = new Map<string, string>();
  let depth = 0;
  let quoted = false;
  let start = 0;
  const push = (end: number) => {
    const member = value.slice(start, end).trim();
    const eq = member.indexOf("=");
    if (eq > 0) members.set(member.slice(0, eq), member.slice(eq + 1));
    else if (member) members.set(member, "");
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(value.length);
  return members;
}

/** The bytes of a byte-sequence item `:<base64>:`, or null. */
function byteSequence(value: string | undefined): Buffer | null {
  const match = value?.trim().match(/^:([A-Za-z0-9+/]*={0,2}):$/);
  return match?.[1] === undefined ? null : Buffer.from(match[1], "base64");
}

type SignatureInput = {
  components: string[];
  params: Map<string, string | number>;
};

/** Parse `("a" "b");created=1;alg="ed25519"`; null when malformed. */
function parseSignatureInput(raw: string): SignatureInput | null {
  const list = raw.match(/^\(((?:"[^"\\]*"(?: "[^"\\]*")*)?)\)(.*)$/);
  if (!list) return null;
  const components = Array.from(
    (list[1] ?? "").matchAll(/"([^"\\]*)"/g),
    (m) => m[1] ?? ""
  );
  const params = new Map<string, string | number>();
  let rest = list[2] ?? "";
  while (rest) {
    const param = rest.match(
      /^;([a-z*][a-z0-9_.*-]*)=(?:"([^"\\]*)"|(-?\d{1,15}))/
    );
    if (!param?.[1] || params.has(param[1])) return null;
    params.set(param[1], param[2] !== undefined ? param[2] : Number(param[3]));
    rest = rest.slice(param[0].length);
  }
  return { components, params };
}

function contentDigestMatches(header: string, body: Uint8Array): boolean {
  const claimed = byteSequence(dictionaryMembers(header).get("sha-256"));
  if (claimed?.length !== 32) return false;
  return timingSafeEqual(claimed, createHash("sha256").update(body).digest());
}

function requestTarget(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

export function verifyWoodpeckerSignature(
  req: SignedRequest,
  publicKeyPem: string
): SignatureCheck {
  const inputHeader = req.headers.get("signature-input");
  const signatureHeader = req.headers.get("signature");
  const digestHeader = req.headers.get("content-digest");
  if (!inputHeader || !signatureHeader || !digestHeader) {
    return fail("missing signature headers");
  }

  const rawParams = dictionaryMembers(inputHeader).get(
    WOODPECKER_SIGNATURE_LABEL
  );
  const input = rawParams ? parseSignatureInput(rawParams) : null;
  if (!rawParams || !input) return fail("no usable Signature-Input");

  const covered = [...input.components].sort();
  if (
    covered.length !== REQUIRED_COMPONENTS.length ||
    !REQUIRED_COMPONENTS.every((c, i) => covered[i] === c)
  ) {
    return fail("signature does not cover the required components");
  }

  const alg = input.params.get("alg");
  if (alg !== undefined && alg !== "ed25519") return fail("unsupported alg");

  const now = Date.now() / 1000;
  const created = input.params.get("created");
  if (typeof created !== "number") return fail("missing created");
  if (Math.abs(now - created) > MAX_SKEW_SECONDS) {
    return fail("signature too old or from the future");
  }
  const expires = input.params.get("expires");
  if (expires !== undefined && (typeof expires !== "number" || expires < now)) {
    return fail("signature expired");
  }

  const signature = byteSequence(
    dictionaryMembers(signatureHeader).get(WOODPECKER_SIGNATURE_LABEL)
  );
  if (signature?.length !== 64) return fail("no usable Signature");

  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return fail("invalid public key");
  }
  if (key.asymmetricKeyType !== "ed25519") return fail("not an ed25519 key");

  const values: Record<(typeof REQUIRED_COMPONENTS)[number], string> = {
    "@request-target": requestTarget(req.url),
    "content-digest": digestHeader,
  };
  const base = [
    ...input.components.map(
      (c) => `"${c}": ${values[c as keyof typeof values]}`
    ),
    `"@signature-params": ${rawParams}`,
  ].join("\n");

  if (!verify(null, Buffer.from(base), key, signature)) {
    return fail("signature mismatch");
  }
  if (!contentDigestMatches(digestHeader, req.body)) {
    return fail("body does not match Content-Digest");
  }
  return { ok: true };
}

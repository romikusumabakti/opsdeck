import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyWoodpeckerSignature } from "@/lib/ci/http-signature";

// Produced by github.com/yaronf/httpsign v0.6.2 configured exactly like
// Woodpecker v3.20.1's extension signer: the ground truth for the format.
const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/woodpecker-signed-request.json", import.meta.url),
    "utf8"
  )
) as {
  publicKeyPem: string;
  request: {
    body: string;
    headers: Record<string, string>;
    host: string;
    method: string;
    requestURI: string;
  };
};
const FIXTURE_CREATED = 1793804777;

function fixtureRequest(
  overrides: { body?: string; requestURI?: string } = {}
) {
  const { request } = fixture;
  return {
    method: request.method,
    url: `http://${request.host}${overrides.requestURI ?? request.requestURI}`,
    headers: new Headers(request.headers),
    body: new TextEncoder().encode(overrides.body ?? request.body),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("verifyWoodpeckerSignature against the httpsign fixture", () => {
  it("accepts the request as Woodpecker signed it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXTURE_CREATED * 1000 + 5000);
    expect(
      verifyWoodpeckerSignature(fixtureRequest(), fixture.publicKeyPem)
    ).toEqual({ ok: true });
  });

  it("rejects one changed body byte, a changed query, a changed path, another key", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXTURE_CREATED * 1000 + 5000);
    const body = fixture.request.body.replace('"id":2', '"id":3');
    expect(body).not.toBe(fixture.request.body);
    expect(
      verifyWoodpeckerSignature(fixtureRequest({ body }), fixture.publicKeyPem)
        .ok
    ).toBe(false);
    expect(
      verifyWoodpeckerSignature(
        fixtureRequest({
          requestURI: fixture.request.requestURI.replace("?x=1", "?x=2"),
        }),
        fixture.publicKeyPem
      ).ok
    ).toBe(false);
    expect(
      verifyWoodpeckerSignature(
        fixtureRequest({
          requestURI: fixture.request.requestURI.replace("?x=1", ""),
        }),
        fixture.publicKeyPem
      ).ok
    ).toBe(false);
    expect(
      verifyWoodpeckerSignature(
        fixtureRequest({
          requestURI: fixture.request.requestURI.replace(
            "0190a1b2",
            "0190a1b3"
          ),
        }),
        fixture.publicKeyPem
      ).ok
    ).toBe(false);
    const otherKey = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(verifyWoodpeckerSignature(fixtureRequest(), otherKey).ok).toBe(
      false
    );
  });

  it("rejects the fixture long after it was created", () => {
    vi.useFakeTimers();
    vi.setSystemTime((FIXTURE_CREATED + 600) * 1000);
    expect(
      verifyWoodpeckerSignature(fixtureRequest(), fixture.publicKeyPem).ok
    ).toBe(false);
  });
});

// Independent of the fixture and of the code under test: the signature base
// is assembled here by hand from RFC 9421 section 2.5.
describe("verifyWoodpeckerSignature with a locally signed request", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const PATH = "/api/ci/config/0197f3a0-1b2c-7def-8000-0123456789a1";

  function signed(
    body: string,
    options: { created?: number; key?: KeyObject; target?: string } = {}
  ) {
    const created = options.created ?? Math.floor(Date.now() / 1000);
    const digest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
    const params = `("@request-target" "content-digest");created=${created};alg="ed25519"`;
    const base = [
      `"@request-target": ${options.target ?? PATH}`,
      `"content-digest": ${digest}`,
      `"@signature-params": ${params}`,
    ].join("\n");
    const signature = sign(
      null,
      Buffer.from(base),
      options.key ?? privateKey
    ).toString("base64");
    return {
      method: "POST",
      url: `https://panel.example.test${PATH}`,
      headers: new Headers({
        "Content-Type": "application/json",
        "Content-Digest": digest,
        "Signature-Input": `woodpecker-ci-extensions=${params}`,
        Signature: `woodpecker-ci-extensions=:${signature}:`,
      }),
      body: new TextEncoder().encode(body),
    };
  }

  const BODY = JSON.stringify({ repo: { id: 7 }, pipeline: {} });

  it("accepts a valid signature", () => {
    expect(verifyWoodpeckerSignature(signed(BODY), pem)).toEqual({ ok: true });
  });

  it("rejects a body changed after signing", () => {
    const req = signed(BODY);
    req.body = new TextEncoder().encode(BODY.replace("7", "8"));
    expect(verifyWoodpeckerSignature(req, pem).ok).toBe(false);
  });

  it("rejects a body changed together with its Content-Digest", () => {
    const req = signed(BODY);
    const other = BODY.replace("7", "8");
    req.headers.set(
      "Content-Digest",
      `sha-256=:${createHash("sha256").update(other).digest("base64")}:`
    );
    req.body = new TextEncoder().encode(other);
    expect(verifyWoodpeckerSignature(req, pem).ok).toBe(false);
  });

  it("rejects a signature by another key", () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(
      verifyWoodpeckerSignature(signed(BODY, { key: other }), pem).ok
    ).toBe(false);
  });

  it("rejects a signature created 10 minutes ago, or 10 minutes ahead", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      verifyWoodpeckerSignature(signed(BODY, { created: now - 600 }), pem).ok
    ).toBe(false);
    expect(
      verifyWoodpeckerSignature(signed(BODY, { created: now + 600 }), pem).ok
    ).toBe(false);
  });

  it("rejects missing or foreign signature headers and a broken key", () => {
    for (const header of ["Signature", "Signature-Input", "Content-Digest"]) {
      const req = signed(BODY);
      req.headers.delete(header);
      expect(verifyWoodpeckerSignature(req, pem).ok).toBe(false);
    }
    const renamed = signed(BODY);
    renamed.headers.set(
      "Signature-Input",
      (renamed.headers.get("Signature-Input") ?? "").replace(
        "woodpecker-ci-extensions",
        "other"
      )
    );
    expect(verifyWoodpeckerSignature(renamed, pem).ok).toBe(false);
    expect(verifyWoodpeckerSignature(signed(BODY), "not a pem").ok).toBe(false);
  });

  it("rejects a signature that does not cover both components", () => {
    const req = signed(BODY);
    req.headers.set(
      "Signature-Input",
      (req.headers.get("Signature-Input") ?? "").replace(
        ' "content-digest"',
        ""
      )
    );
    expect(verifyWoodpeckerSignature(req, pem).ok).toBe(false);
  });

  it("rejects an alg other than ed25519", () => {
    const req = signed(BODY);
    req.headers.set(
      "Signature-Input",
      (req.headers.get("Signature-Input") ?? "").replace(
        'alg="ed25519"',
        'alg="rsa-pss-sha512"'
      )
    );
    expect(verifyWoodpeckerSignature(req, pem).ok).toBe(false);
  });
});

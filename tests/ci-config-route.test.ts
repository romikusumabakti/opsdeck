import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BuildSpec, buildSpecSchema } from "@/lib/ci/build-spec";

const CONNECTION_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const OTHER_CONNECTION_ID = "0197f3a0-1b2c-7def-8000-0123456789a9";
const NO_KEY_CONNECTION_ID = "0197f3a0-1b2c-7def-8000-0123456789a2";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

const SPEC: BuildSpec = buildSpecSchema.parse({
  branches: ["main"],
  tagShaLength: 9,
  images: [{ name: "hris-backend", dockerfile: "Dockerfile", context: "." }],
  bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
  checks: [],
});

const service = vi.hoisted(() => ({
  findExtensionKey: vi.fn(),
  findComponentByCiRepo: vi.fn(),
}));
vi.mock("@/server/services/ci-config", () => service);

const pipeline = vi.hoisted(() => ({ generateWoodpeckerPipeline: vi.fn() }));
vi.mock("@/lib/ci/pipeline", () => pipeline);

const { app } = await import("@/server/app");

function deliver(
  payload: unknown,
  options: { connectionId?: string; tamper?: boolean } = {}
) {
  const body = JSON.stringify(payload);
  const path = `/api/ci/config/${options.connectionId ?? CONNECTION_ID}`;
  const digest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
  const params = `("@request-target" "content-digest");created=${Math.floor(Date.now() / 1000)};alg="ed25519"`;
  const base = `"@request-target": ${path}\n"content-digest": ${digest}\n"@signature-params": ${params}`;
  const signature = sign(null, Buffer.from(base), privateKey).toString(
    "base64"
  );
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Digest": digest,
      "Signature-Input": `woodpecker-ci-extensions=${params}`,
      Signature: `woodpecker-ci-extensions=:${signature}:`,
    },
    body: options.tamper ? body.replace("main", "evil") : body,
  });
}

const PAYLOAD = {
  repo: { id: 2, full_name: "dss-consulting/hris" },
  pipeline: { branch: "main", event: "push" },
  netrc: { machine: "bitbucket.org", login: "x", password: "secret" },
  restart: false,
};

beforeEach(() => {
  service.findExtensionKey.mockImplementation(async (id: string) => {
    if (id === CONNECTION_ID) return { publicKeyPem: PEM };
    if (id === NO_KEY_CONNECTION_ID) return { publicKeyPem: null };
    return null;
  });
  service.findComponentByCiRepo.mockResolvedValue(null);
  pipeline.generateWoodpeckerPipeline.mockReturnValue("steps: []\n");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("POST /api/ci/config/:connectionId", () => {
  it("answers 204 for a repo the Panel does not know", async () => {
    const res = await deliver(PAYLOAD);
    expect(res.status).toBe(204);
    expect(service.findComponentByCiRepo).toHaveBeenCalledWith(
      CONNECTION_ID,
      "2"
    );
  });

  it("answers 204 for a component in custom mode", async () => {
    service.findComponentByCiRepo.mockResolvedValue({
      componentKey: "hris",
      pipelineMode: "custom",
      buildSpec: null,
    });
    const res = await deliver(PAYLOAD);
    expect(res.status).toBe(204);
    expect(pipeline.generateWoodpeckerPipeline).not.toHaveBeenCalled();
  });

  it("serves the generated pipeline for a generated component", async () => {
    service.findComponentByCiRepo.mockResolvedValue({
      componentKey: "hris",
      pipelineMode: "generated",
      buildSpec: SPEC,
    });
    const res = await deliver(PAYLOAD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configs: [{ name: ".woodpecker.yaml", data: "steps: []\n" }],
    });
    expect(pipeline.generateWoodpeckerPipeline).toHaveBeenCalledWith(
      "hris",
      SPEC
    );
  });

  it("answers 204 and warns when the pipeline cannot be generated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    service.findComponentByCiRepo.mockResolvedValue({
      componentKey: "hris",
      pipelineMode: "generated",
      buildSpec: SPEC,
    });
    pipeline.generateWoodpeckerPipeline.mockImplementation(() => {
      throw new Error("DEPLOY_REGISTRY is not set");
    });
    const res = await deliver(PAYLOAD);
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });

  it("answers the same 401 for a bad signature, a tampered body and an unknown connection", async () => {
    service.findComponentByCiRepo.mockResolvedValue({
      componentKey: "hris",
      pipelineMode: "generated",
      buildSpec: SPEC,
    });
    const unsigned = await app.request(`/api/ci/config/${CONNECTION_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PAYLOAD),
    });
    const responses = [
      unsigned,
      await deliver(PAYLOAD, { tamper: true }),
      await deliver(PAYLOAD, { connectionId: OTHER_CONNECTION_ID }),
      await deliver(PAYLOAD, { connectionId: "not-a-uuid" }),
    ];
    const bodies = await Promise.all(responses.map((r) => r.text()));
    for (const [i, res] of responses.entries()) {
      expect(res.status).toBe(401);
      expect(bodies[i]).toBe(bodies[0]);
    }
    expect(pipeline.generateWoodpeckerPipeline).not.toHaveBeenCalled();
  });

  it("accepts the real httpsign-signed fixture end to end", async () => {
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
        requestURI: string;
      };
    };
    service.findExtensionKey.mockResolvedValue({
      publicKeyPem: fixture.publicKeyPem,
    });
    service.findComponentByCiRepo.mockResolvedValue({
      componentKey: "dplk-customer-portal-cms",
      pipelineMode: "generated",
      buildSpec: SPEC,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1793804777 * 1000 + 5000);
    try {
      const send = (body: string) =>
        app.request(
          `http://${fixture.request.host}${fixture.request.requestURI}`,
          { method: "POST", headers: fixture.request.headers, body }
        );
      const res = await send(fixture.request.body);
      expect(res.status).toBe(200);
      expect(service.findComponentByCiRepo).toHaveBeenCalledWith(
        "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        "2"
      );
      const tampered = await send(
        fixture.request.body.replace('"id":2', '"id":3')
      );
      expect(tampered.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 503 for a connection without a stored key", async () => {
    const res = await deliver(PAYLOAD, { connectionId: NO_KEY_CONNECTION_ID });
    expect(res.status).toBe(503);
    expect(service.findComponentByCiRepo).not.toHaveBeenCalled();
  });
});

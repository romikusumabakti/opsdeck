import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactImageError, openArtifactLayer } from "@/lib/registry/artifact";

const DOCKER = "application/vnd.docker.distribution.manifest.v2+json";
const LAYER = "application/vnd.docker.image.rootfs.diff.tar.gzip";
const DIGEST = `sha256:${"a".repeat(64)}`;
const PASSWORD = "s3cr3t-pw";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const dockerManifest = (
  layers = [{ mediaType: LAYER, digest: DIGEST, size: 5 }]
) => ({
  schemaVersion: 2,
  mediaType: DOCKER,
  layers,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("DEPLOY_REGISTRY", "192.168.56.113:5000");
  vi.stubEnv("DEPLOY_REGISTRY_SCHEME", "http");
  vi.stubEnv("DEPLOY_REGISTRY_USERNAME", "panel");
  vi.stubEnv("DEPLOY_REGISTRY_PASSWORD", PASSWORD);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("openArtifactLayer", () => {
  it("returns the raw blob stream of a single-layer Docker image with Basic auth", async () => {
    fetchMock
      .mockResolvedValueOnce(json(dockerManifest()))
      .mockResolvedValueOnce(new Response("gzdata"));
    const layer = await openArtifactLayer("core-deploy", "main-abc");
    expect(layer.digest).toBe(DIGEST);
    expect(layer.size).toBe(5);
    expect(await new Response(layer.stream).text()).toBe("gzdata");

    const [manifestUrl, manifestInit] = fetchMock.mock.calls[0] ?? [];
    expect(manifestUrl).toBe(
      "http://192.168.56.113:5000/v2/core-deploy/manifests/main-abc"
    );
    expect(manifestInit.headers.Accept.startsWith(DOCKER)).toBe(true);
    expect(manifestInit.headers.Authorization).toBe(
      `Basic ${Buffer.from(`panel:${PASSWORD}`).toString("base64")}`
    );
    const [blobUrl, blobInit] = fetchMock.mock.calls[1] ?? [];
    expect(blobUrl).toBe(
      `http://192.168.56.113:5000/v2/core-deploy/blobs/${DIGEST}`
    );
    expect(blobInit.headers.Authorization).toMatch(/^Basic /);
  });

  it("defaults to https and omits Authorization without credentials", async () => {
    vi.stubEnv("DEPLOY_REGISTRY_SCHEME", "");
    vi.stubEnv("DEPLOY_REGISTRY_USERNAME", "");
    vi.stubEnv("DEPLOY_REGISTRY_PASSWORD", "");
    fetchMock
      .mockResolvedValueOnce(json(dockerManifest()))
      .mockResolvedValueOnce(new Response("x"));
    await openArtifactLayer("core-deploy", "t");
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/^https:\/\//);
    expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBeUndefined();
  });

  it.each([
    [
      "an OCI index",
      { mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] },
    ],
    [
      "an OCI manifest",
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        layers: [{ mediaType: LAYER, digest: DIGEST, size: 5 }],
      },
    ],
    [
      "a two-layer manifest",
      dockerManifest([
        { mediaType: LAYER, digest: DIGEST, size: 5 },
        { mediaType: LAYER, digest: `sha256:${"b".repeat(64)}`, size: 6 },
      ]),
    ],
  ])("rejects %s", async (_name, body) => {
    fetchMock.mockResolvedValueOnce(json(body));
    const err = await openArtifactLayer("core-deploy", "t").catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactImageError);
    expect(err.message).toMatch(
      /^artifact image must be a single-layer Docker image \(.+\)$/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts OCI and list manifest types so the registry returns what it stores", async () => {
    fetchMock
      .mockResolvedValueOnce(json(dockerManifest()))
      .mockResolvedValueOnce(new Response("x"));
    await openArtifactLayer("core-deploy", "t");
    const accept: string = fetchMock.mock.calls[0]?.[1].headers.Accept;
    expect(accept.startsWith(DOCKER)).toBe(true);
    expect(accept).toContain("application/vnd.oci.image.index.v1+json");
    expect(accept).toContain("application/vnd.oci.image.manifest.v1+json");
    expect(accept).toContain(
      "application/vnd.docker.distribution.manifest.list.v2+json"
    );
  });

  it("names the received media type when rejecting", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ mediaType: "application/vnd.oci.image.index.v1+json" })
    );
    await expect(openArtifactLayer("core-deploy", "t")).rejects.toThrow(
      /application\/vnd\.oci\.image\.index\.v1\+json/
    );
  });

  it("rejects a malformed layer digest before building the blob URL", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        dockerManifest([{ mediaType: LAYER, digest: "sha256:../x", size: 5 }])
      )
    );
    await expect(openArtifactLayer("core-deploy", "t")).rejects.toBeInstanceOf(
      ArtifactImageError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns a non-JSON manifest into ArtifactImageError", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    await expect(openArtifactLayer("core-deploy", "t")).rejects.toBeInstanceOf(
      ArtifactImageError
    );
  });

  it("reports a missing manifest", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(openArtifactLayer("core-deploy", "gone")).rejects.toThrow(
      "artifact core-deploy:gone not found in the registry"
    );
  });

  it("reports an authentication failure without the password", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    const err = await openArtifactLayer("core-deploy", "t").catch((e) => e);
    expect(err.message).toMatch(/authentication/);
    expect(err.message).not.toContain(PASSWORD);
    expect(err.message).not.toContain(
      Buffer.from(`panel:${PASSWORD}`).toString("base64")
    );
  });

  it("fails when the blob request fails", async () => {
    fetchMock
      .mockResolvedValueOnce(json(dockerManifest()))
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(openArtifactLayer("core-deploy", "t")).rejects.toThrow(
      /HTTP 500/
    );
  });
});

describe("openArtifactLayer timeouts", () => {
  const never = () => new Promise<Response>(() => {});
  const signalOf = (call: number): AbortSignal =>
    fetchMock.mock.calls[call]?.[1].signal;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a manifest request that never answers after 30 s", async () => {
    fetchMock.mockImplementationOnce(never);
    const result = openArtifactLayer("core-deploy", "main-abc").catch(
      (e: Error) => e
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signalOf(0).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await result;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "registry did not answer within 30 s for manifest core-deploy:main-abc"
    );
    expect((err as Error).message).not.toContain(PASSWORD);
    expect(signalOf(0).aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up on a blob request whose headers never arrive", async () => {
    fetchMock
      .mockResolvedValueOnce(json(dockerManifest()))
      .mockImplementationOnce(never);
    const result = openArtifactLayer("core-deploy", "t").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await result;
    expect((err as Error).message).toBe(
      `registry did not answer within 30 s for blob ${DIGEST}`
    );
    expect(signalOf(1).aborted).toBe(true);
  });

  it("never bounds the blob body once its headers arrived", async () => {
    fetchMock
      .mockResolvedValueOnce(json(dockerManifest()))
      .mockResolvedValueOnce(new Response("gzdata"));
    const layer = await openArtifactLayer("core-deploy", "t");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(signalOf(1).aborted).toBe(false);
    expect(await new Response(layer.stream).text()).toBe("gzdata");
  });
});

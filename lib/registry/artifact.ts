/**
 * Registry client for artifact images (`<componentKey>-deploy:<tag>`).
 *
 * An artifact image is a single-layer Docker image whose one layer is the
 * deploy bundle. `openArtifactLayer` returns that layer's raw blob (gzip tar)
 * as a stream, without decompressing it.
 */

const MANIFEST_TYPE = "application/vnd.docker.distribution.manifest.v2+json";
// Docker first, then the types we reject: registry:2 answers 404 when the
// stored manifest type is not acceptable, which would hide the real problem.
const MANIFEST_ACCEPT = [
  MANIFEST_TYPE,
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const LAYER_TYPE = "application/vnd.docker.image.rootfs.diff.tar.gzip";

export class ArtifactImageError extends Error {
  constructor(detail: string) {
    super(`artifact image must be a single-layer Docker image (${detail})`);
    this.name = "ArtifactImageError";
  }
}

type Manifest = {
  mediaType?: unknown;
  layers?: { mediaType?: unknown; digest?: unknown; size?: unknown }[];
};

function registryRequest(path: string, accept?: string) {
  const registry = process.env.DEPLOY_REGISTRY;
  if (!registry) throw new Error("DEPLOY_REGISTRY is not set");
  const scheme = process.env.DEPLOY_REGISTRY_SCHEME || "https";
  const headers: Record<string, string> = {};
  if (accept) headers.Accept = accept;
  const username = process.env.DEPLOY_REGISTRY_USERNAME;
  const password = process.env.DEPLOY_REGISTRY_PASSWORD;
  if (username && password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }
  return { url: `${scheme}://${registry}${path}`, headers };
}

function failStatus(what: string, res: Response): Error {
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `registry authentication failed while reading ${what} (HTTP ${res.status}); check DEPLOY_REGISTRY_USERNAME and DEPLOY_REGISTRY_PASSWORD`
    );
  }
  return new Error(`registry returned HTTP ${res.status} for ${what}`);
}

export async function openArtifactLayer(
  image: string,
  tag: string
): Promise<{
  size: number;
  digest: string;
  stream: ReadableStream<Uint8Array>;
}> {
  const manifestReq = registryRequest(
    `/v2/${image}/manifests/${tag}`,
    MANIFEST_ACCEPT
  );
  const manifestRes = await fetch(manifestReq.url, {
    headers: manifestReq.headers,
  });
  if (manifestRes.status === 404) {
    throw new Error(`artifact ${image}:${tag} not found in the registry`);
  }
  if (!manifestRes.ok)
    throw failStatus(`manifest ${image}:${tag}`, manifestRes);

  let manifest: Manifest;
  try {
    manifest = (await manifestRes.json()) as Manifest;
  } catch {
    throw new ArtifactImageError("manifest is not valid JSON");
  }
  if (manifest.mediaType !== MANIFEST_TYPE) {
    throw new ArtifactImageError(
      `manifest media type is ${String(manifest.mediaType)}, expected ${MANIFEST_TYPE}`
    );
  }
  const layers = manifest.layers ?? [];
  const layer = layers[0];
  if (layers.length !== 1 || !layer) {
    throw new ArtifactImageError(`found ${layers.length} layers, expected 1`);
  }
  if (layer.mediaType !== LAYER_TYPE) {
    throw new ArtifactImageError(
      `layer media type is ${String(layer.mediaType)}, expected ${LAYER_TYPE}`
    );
  }
  if (
    typeof layer.digest !== "string" ||
    !DIGEST_PATTERN.test(layer.digest) ||
    typeof layer.size !== "number"
  ) {
    throw new ArtifactImageError("layer has no valid sha256 digest or size");
  }

  const blobReq = registryRequest(`/v2/${image}/blobs/${layer.digest}`);
  const blobRes = await fetch(blobReq.url, {
    headers: blobReq.headers,
    redirect: "follow",
  });
  if (!blobRes.ok) {
    await blobRes.body?.cancel();
    throw failStatus(`blob ${layer.digest}`, blobRes);
  }
  if (!blobRes.body)
    throw new Error(`registry sent no body for blob ${layer.digest}`);
  return { size: layer.size, digest: layer.digest, stream: blobRes.body };
}

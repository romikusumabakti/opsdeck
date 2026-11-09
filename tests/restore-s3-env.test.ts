import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESTORE_S3_ENV,
  restoreS3Source,
} from "@/lib/instance-backup/destination";
import { openBackupSource, RestoreError } from "@/lib/instance-backup/restore";

// install.sh --restore s3://… on a fresh install: the restore CLI reads the
// backup from the S3 store named by OPSDECK_RESTORE_S3_*, because the new
// database has no destination yet.

const SECRET = "restore-secret-Zq9/never-shown";
const FULL = {
  OPSDECK_RESTORE_S3_ENDPOINT: "https://account.r2.example.test",
  OPSDECK_RESTORE_S3_REGION: "auto",
  OPSDECK_RESTORE_S3_BUCKET: "opsdeck-dr",
  OPSDECK_RESTORE_S3_ACCESS_KEY_ID: "AKIDRESTORE",
  OPSDECK_RESTORE_S3_SECRET_ACCESS_KEY: SECRET,
  OPSDECK_RESTORE_S3_FORCE_PATH_STYLE: "true",
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "restore-env-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeS3(objects: Record<string, string>) {
  const seen: { method: string; host: string; path: string }[] = [];
  const requestHandler = {
    async handle(request: {
      method: string;
      hostname: string;
      path: string;
      headers: Record<string, string>;
    }) {
      seen.push({
        method: request.method,
        host: request.hostname,
        path: request.path,
      });
      const key = decodeURIComponent(
        request.path.replace(/^\/opsdeck-dr\//, "")
      );
      const body = objects[key];
      return {
        response: {
          statusCode: body === undefined ? 404 : 200,
          headers: { "content-type": "application/octet-stream" },
          body: Readable.from([
            Buffer.from(body ?? "<Error><Code>NoSuchKey</Code></Error>"),
          ]),
        },
      };
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs() {
      return {};
    },
  };
  return { requestHandler: requestHandler as never, seen };
}

describe("restoreS3Source", () => {
  it("is null when no OPSDECK_RESTORE_S3_* is set", () => {
    expect(restoreS3Source({})).toBeNull();
  });

  it("names the missing keys and never a value", () => {
    const env = {
      ...FULL,
      OPSDECK_RESTORE_S3_BUCKET: "",
      OPSDECK_RESTORE_S3_ACCESS_KEY_ID: "",
    };
    let message = "";
    try {
      restoreS3Source(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(RESTORE_S3_ENV.bucket);
    expect(message).toContain(RESTORE_S3_ENV.accessKeyId);
    expect(message).not.toContain(SECRET);
  });

  it.each([
    [
      "an endpoint that is not http(s)",
      { OPSDECK_RESTORE_S3_ENDPOINT: "s3.example.test" },
    ],
    ["a bad path-style flag", { OPSDECK_RESTORE_S3_FORCE_PATH_STYLE: "yes" }],
  ])("rejects %s", (_label, patch) => {
    expect(() => restoreS3Source({ ...FULL, ...patch })).toThrow(
      /OPSDECK_RESTORE_S3_/
    );
  });

  it("reads from the bucket path-style, with the region defaulting to auto", async () => {
    const s3 = fakeS3({ "opsdeck-backups/opsdeck/b1/manifest.json": "{}" });
    const { OPSDECK_RESTORE_S3_REGION: _r, ...noRegion } = FULL;
    const store = restoreS3Source(noRegion, {
      requestHandler: s3.requestHandler,
    });
    const file = join(root, "m.json");
    await store?.download("opsdeck-backups/opsdeck/b1/manifest.json", file);
    expect(await readFile(file, "utf8")).toBe("{}");
    expect(s3.seen[0]).toEqual({
      method: "GET",
      host: "account.r2.example.test",
      path: "/opsdeck-dr/opsdeck-backups/opsdeck/b1/manifest.json",
    });
  });
});

describe("openBackupSource", () => {
  it("prefers the env store over the database destination for an S3 key", async () => {
    const s3 = fakeS3({
      "opsdeck-backups/opsdeck/b1/manifest.json": '{"format":1}',
    });
    const loadDestination = vi.fn(async () => null);
    const source = await openBackupSource(
      "opsdeck-backups/opsdeck/b1/",
      loadDestination,
      root,
      () => restoreS3Source(FULL, { requestHandler: s3.requestHandler })
    );
    expect(await source.readManifest(join(root, "staging"))).toBe(
      '{"format":1}'
    );
    expect(loadDestination).not.toHaveBeenCalled();
  });

  it("uses the database destination when no env store is set", async () => {
    const loadDestination = vi.fn(async () => null);
    await expect(
      openBackupSource(
        "opsdeck-backups/opsdeck/b1/",
        loadDestination,
        root,
        () => null
      )
    ).rejects.toMatchObject({ code: "restoreNotFound" });
    expect(loadDestination).toHaveBeenCalledOnce();
  });

  it("refuses (restoreNotFound, exit 3 path) a partial env, naming keys only", async () => {
    const error = await openBackupSource(
      "opsdeck-backups/opsdeck/b1/",
      async () => null,
      root,
      () => restoreS3Source({ OPSDECK_RESTORE_S3_SECRET_ACCESS_KEY: SECRET })
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RestoreError);
    expect(error).toMatchObject({ code: "restoreNotFound" });
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it("keeps local: keys local even with the env set", async () => {
    const source = await openBackupSource(
      "local:opsdeck/b1/",
      async () => null,
      root,
      () => {
        throw new Error("must not be read");
      }
    );
    await expect(source.readManifest(root)).rejects.toThrow();
  });
});

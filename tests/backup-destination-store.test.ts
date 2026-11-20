import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

// The backup destination as instance backups and environment archives use it:
// built from instance_settings.backup_s3_* (its own credentials, not an S3
// connection row), null when unset (backups stay local), with instance backup
// keys put under the destination's key prefix and archive keys used whole.

process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
const { encryptSecret } = await import("@/lib/secrets");
const { destinationFromSettings, prefixedStore } = await import(
  "@/lib/instance-backup/destination"
);

function memory(keys: string[]) {
  const calls: string[] = [];
  return {
    calls,
    store: {
      list: async (prefix: string) => {
        calls.push(`list ${prefix}`);
        return keys
          .filter((k) => k.startsWith(prefix))
          .map((key) => ({ key, size: 1 }));
      },
      download: async (key: string) => {
        calls.push(`download ${key}`);
        return 1;
      },
      read: async (key: string) => {
        calls.push(`read ${key}`);
        return Readable.from([]);
      },
      upload: async (key: string) => {
        calls.push(`upload ${key}`);
      },
      delete: async (doomed: string[]) => {
        calls.push(`delete ${doomed.join(",")}`);
      },
    },
  };
}

describe("prefixedStore", () => {
  it("puts every key under the prefix and hands keys back relative", async () => {
    const inner = memory([
      "acme/menara-backups/x/manifest.json",
      "acme/menara-backups/x/database.dump",
    ]);
    const store = prefixedStore(inner.store, "acme/");
    expect(await store.list("menara-backups/")).toEqual([
      { key: "menara-backups/x/manifest.json", size: 1 },
      { key: "menara-backups/x/database.dump", size: 1 },
    ]);
    await store.download("menara-backups/x/database.dump", "/tmp/unused");
    await store.read("menara-backups/x/manifest.json");
    await store.upload("menara-backups/y/database.dump", "/tmp/unused");
    await store.delete(["menara-backups/x/a", "menara-backups/x/b"]);
    expect(inner.calls).toEqual([
      "list acme/menara-backups/",
      "download acme/menara-backups/x/database.dump",
      "read acme/menara-backups/x/manifest.json",
      "upload acme/menara-backups/y/database.dump",
      "delete acme/menara-backups/x/a,acme/menara-backups/x/b",
    ]);
  });

  it("is the store itself without a prefix", () => {
    const inner = memory([]);
    expect(prefixedStore(inner.store, null)).toBe(inner.store);
  });
});

const settings = (extra: Record<string, unknown> = {}) => ({
  backupS3Endpoint: "https://objects.example.test",
  backupS3Region: "auto",
  backupS3Bucket: "fictional-menara-backups",
  backupS3AccessKeyId: "AKFICTIONALMENARA",
  backupS3SecretKey: encryptSecret("fictional-menara-secret"),
  backupS3ForcePathStyle: true,
  backupS3KeyPrefix: null as string | null,
  backupKeepDaily: 14,
  backupKeepWeekly: 8,
  ...extra,
});

// A fake S3 transport: records each request's method and path.
function fakeS3() {
  const seen: string[] = [];
  const requestHandler = {
    async handle(request: {
      method: string;
      path: string;
      query: Record<string, string>;
    }) {
      seen.push(`${request.method} ${request.path} ${request.query.prefix}`);
      return {
        response: {
          statusCode: 200,
          headers: { "content-type": "application/xml" },
          body: Readable.from([
            Buffer.from(
              "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"
            ),
          ]),
        },
      };
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs() {
      return {};
    },
  };
  return { seen, extra: { requestHandler: requestHandler as never } };
}

describe("destinationFromSettings", () => {
  it("is null while no destination is set (backups stay local)", () => {
    expect(
      destinationFromSettings(
        settings({
          backupS3Endpoint: null,
          backupS3Region: null,
          backupS3Bucket: null,
          backupS3AccessKeyId: null,
          backupS3SecretKey: null,
        })
      )
    ).toBeNull();
  });

  it("names its location and keeps the retention", () => {
    const destination = destinationFromSettings(
      settings({ backupS3KeyPrefix: "acme/" })
    );
    expect(destination).toMatchObject({
      endpoint: "https://objects.example.test",
      bucket: "fictional-menara-backups",
      keyPrefix: "acme/",
      keepDaily: 14,
      keepWeekly: 8,
    });
    expect(JSON.stringify(destination)).not.toContain(
      "fictional-menara-secret"
    );
  });

  it("writes instance backups under the key prefix and archive keys whole", async () => {
    const s3 = fakeS3();
    const destination = destinationFromSettings(
      settings({ backupS3KeyPrefix: "acme/" }),
      s3.extra
    );
    await destination?.store.list("menara-backups/menara/");
    await destination?.bucketStore.list("menara-env-archives/menara/a/");
    expect(s3.seen).toEqual([
      "GET /fictional-menara-backups/ acme/menara-backups/menara/",
      "GET /fictional-menara-backups/ menara-env-archives/menara/a/",
    ]);
  });

  it("throws when the stored secret can't be decrypted (the run keeps a local copy)", () => {
    expect(() =>
      destinationFromSettings(settings({ backupS3SecretKey: "enc:v1:broken" }))
    ).toThrow();
  });
});

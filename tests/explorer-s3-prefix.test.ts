import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// An environment's storage connection is confined to bucket + key prefix:
// every key the explorer reads, writes, deletes or lists is resolved under
// the prefix, the client only ever sees paths relative to it, and a path that
// could name a key outside it is refused before any request leaves. The S3
// client is a fake that records each command's input.

const sent = vi.hoisted(() => ({
  commands: [] as { name: string; input: Record<string, unknown> }[],
  // What a ListObjectsV2 answers, by the Prefix it was sent.
  listings: {} as Record<
    string,
    { CommonPrefixes?: { Prefix: string }[]; Contents?: { Key: string }[] }
  >,
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const real = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  class S3Client {
    async send(command: { constructor: { name: string }; input: never }) {
      const input = command.input as Record<string, unknown>;
      sent.commands.push({ name: command.constructor.name, input });
      if (command.constructor.name === "ListObjectsV2Command") {
        return sent.listings[String(input.Prefix ?? "")] ?? {};
      }
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: Readable.from([]) };
      }
      if (command.constructor.name === "HeadObjectCommand") {
        return { ContentLength: 1 };
      }
      return {};
    }
    destroy() {}
  }
  return { ...real, S3Client };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (_client: unknown, command: { input: { Key: string } }) =>
    `https://objects.example.test/${command.input.Key}?signed`,
}));

const { createS3Backend, testS3Connection } = await import("@/lib/explorer/s3");
const { PathError } = await import("@/lib/explorer/path");

const connection = (keyPrefix: string | null) => ({
  id: "0197f3a0-1b2c-7def-8000-0000000000c1",
  name: "Team A files",
  environmentId: null,
  endpoint: "https://objects.example.test",
  region: "us-east-1",
  bucket: "fictional-bucket",
  keyPrefix,
  accessKeyId: "AKFICTIONAL",
  secretKey: "fictional-secret",
  forcePathStyle: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const keys = () =>
  sent.commands.map((c) => c.input.Key ?? c.input.Prefix ?? c.input.Delete);

beforeEach(() => {
  sent.commands = [];
  sent.listings = {};
});

describe("S3 backend confined to a key prefix", () => {
  const backend = () => createS3Backend(connection("team-a/"));

  it("lists the prefix as the root and hands back relative paths", async () => {
    sent.listings["team-a/"] = {
      CommonPrefixes: [{ Prefix: "team-a/docs/" }],
      Contents: [{ Key: "team-a/" }, { Key: "team-a/readme.txt" }],
    };
    const entries = await backend().list("");
    expect(sent.commands[0]?.input).toMatchObject({
      Bucket: "fictional-bucket",
      Prefix: "team-a/",
    });
    expect(entries.map((e) => e.path)).toEqual(["docs/", "readme.txt"]);
  });

  it("lists a sub-folder under the prefix", async () => {
    sent.listings["team-a/docs/"] = {
      Contents: [{ Key: "team-a/docs/a.txt" }],
    };
    const entries = await backend().list("docs/");
    expect(sent.commands[0]?.input.Prefix).toBe("team-a/docs/");
    expect(entries.map((e) => e.path)).toEqual(["docs/a.txt"]);
  });

  it("drops a listed key that is not under the prefix", async () => {
    sent.listings["team-a/"] = {
      CommonPrefixes: [{ Prefix: "team-b/" }],
      Contents: [{ Key: "team-b/secret.txt" }],
    };
    expect(await backend().list("")).toEqual([]);
  });

  it("resolves an absolute-looking key under the prefix", async () => {
    await backend().readStream("/team-b/secret.txt");
    expect(sent.commands[0]?.input).toMatchObject({
      Bucket: "fictional-bucket",
      Key: "team-a/team-b/secret.txt",
    });
  });

  it("presigns only keys under the prefix", async () => {
    const target = await backend().downloadTarget("docs/a.txt");
    expect(target).toEqual({
      kind: "presigned",
      url: "https://objects.example.test/team-a/docs/a.txt?signed",
    });
  });

  it("writes uploads under the prefix", async () => {
    await backend().writeStream("docs/new.txt", Readable.from(["x"]));
    expect(sent.commands[0]?.input.Key).toBe("team-a/docs/new.txt");
  });

  it("deletes a folder only within the prefix", async () => {
    sent.listings["team-a/docs/"] = {
      Contents: [{ Key: "team-a/docs/a.txt" }],
    };
    await backend().remove("docs/");
    expect(sent.commands.map((c) => c.name)).toEqual([
      "ListObjectsV2Command",
      "DeleteObjectsCommand",
    ]);
    expect(sent.commands[1]?.input.Delete).toEqual({
      Objects: [{ Key: "team-a/docs/a.txt" }],
      Quiet: true,
    });
  });

  it("renames and copies inside the prefix", async () => {
    await backend().rename("a.txt", "b.txt");
    expect(sent.commands.map((c) => [c.name, c.input.Key])).toEqual([
      ["CopyObjectCommand", "team-a/b.txt"],
      ["DeleteObjectCommand", "team-a/a.txt"],
    ]);
    expect(sent.commands[0]?.input.CopySource).toBe(
      `fictional-bucket/${encodeURIComponent("team-a/a.txt")}`
    );
  });

  it.each([
    "../team-b/secret.txt",
    "docs/../../team-b/secret.txt",
    "..\\team-b\\secret.txt",
    "%2e%2e/team-b/secret.txt",
    "%2E%2E%2Fteam-b%2Fsecret.txt",
    "docs%2F..%2F..%2Fteam-b%2Fsecret.txt",
    "%252e%252e/team-b/secret.txt",
    "．．/team-b/secret.txt",
    "docs／..／secret.txt",
  ])("refuses %j on every operation before any request", async (path) => {
    const b = backend();
    await expect(b.list(`${path}/`)).rejects.toBeInstanceOf(PathError);
    await expect(b.stat(path)).rejects.toBeInstanceOf(PathError);
    await expect(b.readStream(path)).rejects.toBeInstanceOf(PathError);
    await expect(b.downloadTarget(path)).rejects.toBeInstanceOf(PathError);
    await expect(
      b.writeStream(path, Readable.from(["x"]))
    ).rejects.toBeInstanceOf(PathError);
    await expect(b.remove(path)).rejects.toBeInstanceOf(PathError);
    await expect(b.remove(`${path}/`)).rejects.toBeInstanceOf(PathError);
    await expect(b.mkdir(`${path}/`)).rejects.toBeInstanceOf(PathError);
    await expect(b.rename("a.txt", path)).rejects.toBeInstanceOf(PathError);
    await expect(b.rename(path, "a.txt")).rejects.toBeInstanceOf(PathError);
    await expect(b.copy("a.txt", path)).rejects.toBeInstanceOf(PathError);
    expect(keys()).toEqual([]);
  });

  it.each(["", "/", "./", "//"])(
    "refuses to delete, rename or overwrite the prefix root %j",
    async (path) => {
      const b = backend();
      await expect(b.remove(path)).rejects.toBeInstanceOf(PathError);
      await expect(b.rename(path, "x/")).rejects.toBeInstanceOf(PathError);
      await expect(b.copy(path, "x/")).rejects.toBeInstanceOf(PathError);
      await expect(
        b.writeStream(path, Readable.from(["x"]))
      ).rejects.toBeInstanceOf(PathError);
      await expect(b.readStream(path)).rejects.toBeInstanceOf(PathError);
      expect(keys()).toEqual([]);
    }
  );

  it("refuses a stored prefix that is not normalised", () => {
    expect(() => createS3Backend(connection("team-a/../"))).toThrow(PathError);
    expect(() => createS3Backend(connection("/team-a/"))).toThrow(PathError);
    expect(() => createS3Backend(connection("team-a"))).toThrow(PathError);
  });

  it("keeps a connection without a prefix at the bucket root", async () => {
    const b = createS3Backend(connection(null));
    await b.readStream("team-b/a.txt");
    expect(sent.commands[0]?.input.Key).toBe("team-b/a.txt");
    await expect(b.readStream("../a.txt")).rejects.toBeInstanceOf(PathError);
  });
});

describe("testS3Connection", () => {
  it("lists one key under the prefix when one is given", async () => {
    await testS3Connection({
      endpoint: "https://objects.example.test",
      region: "us-east-1",
      bucket: "fictional-bucket",
      accessKeyId: "AKFICTIONAL",
      secretKey: "fictional-secret",
      forcePathStyle: true,
      keyPrefix: "team-a/",
    });
    expect(sent.commands[0]?.input).toEqual({
      Bucket: "fictional-bucket",
      MaxKeys: 1,
      Prefix: "team-a/",
    });
  });
});

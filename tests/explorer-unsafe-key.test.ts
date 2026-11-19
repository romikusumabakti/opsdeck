import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// A key the S3 backend refuses because a segment decodes or folds into a
// separator or a dot segment ("%2e%2e", "%2F", "．．") comes back with the
// code `unsupportedObjectName`, so the explorer can word it; other path
// refusals keep `invalidPath`. The backend here confines keys with the real
// normalizeS3Key.

vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({ user: { id: "u1", role: "engineer" } }),
}));
vi.mock("@/lib/restricted-targets", () => ({
  authorizeExplorerSource: async () => ({ user: { id: "u1" } }),
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));
vi.mock("@/lib/explorer", async () => {
  const { normalizeS3Key } = await import("@/lib/explorer/path");
  const check = async (p: string) => {
    normalizeS3Key(p, true);
  };
  return {
    resolveBackend: async () => ({
      list: async (p: string) => {
        await check(p);
        return [];
      },
      readStream: async (p: string) => {
        await check(p);
        return Readable.from([]);
      },
      remove: check,
    }),
    targetName: async () => "assets-bucket",
  };
});

const { explorerRouter } = await import("@/server/routes/explorer");
const explorer = await import("@/server/services/explorer");
const { PathError, UnsafeKeyError } = await import("@/lib/explorer/path");
const { normalizeS3Key } = await import("@/lib/explorer/path");

const s3 = {
  kind: "s3",
  connectionId: "0197f3a0-1b2c-7def-8000-0000000000b1",
} as const;

describe("unsupported object names", () => {
  it("throws a distinct PathError for decoded or folded separators", () => {
    for (const key of ["%2e%2e/x", "a%2Fb", "．．/x", "%252e%252e/x"]) {
      expect(() => normalizeS3Key(key)).toThrow(UnsafeKeyError);
    }
    expect(() => normalizeS3Key("../x")).toThrow(PathError);
    expect(() => normalizeS3Key("../x")).not.toThrow(UnsafeKeyError);
  });

  it("answers the services with the code", async () => {
    expect(await explorer.listEntries(s3, "%2e%2e/")).toEqual({
      success: false,
      message: "unsupportedObjectName",
      code: "unsupportedObjectName",
    });
    expect(await explorer.deleteEntry(s3, "a%2Fb")).toEqual({
      success: false,
      message: "unsupportedObjectName",
      code: "unsupportedObjectName",
    });
    expect(await explorer.deleteEntry(s3, "../x")).toEqual({
      success: false,
      message: "invalidPath",
    });
  });

  it("answers the download route with a coded 400", async () => {
    const res = await explorerRouter.request(
      `/download?source=${encodeURIComponent(JSON.stringify(s3))}&path=${encodeURIComponent("．．/x")}`
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "unsupportedObjectName",
      code: "unsupportedObjectName",
    });
  });
});

import { describe, expect, it } from "bun:test";
import {
  confineSftpPath,
  normalizeS3Key,
  PathError,
} from "@/lib/explorer/path";

describe("confineSftpPath", () => {
  it("navigates into subdirectories when root is /", () => {
    // Regression: root "/" made the prefix check compare against "//", so every
    // subpath threw "Invalid path" and only the root listing worked.
    expect(confineSftpPath("/", "deployments/")).toBe("/deployments/");
    expect(confineSftpPath("/", "a/b/c")).toBe("/a/b/c");
    expect(confineSftpPath("/", "")).toBe("/");
  });

  it("confines under a non-root root", () => {
    expect(confineSftpPath("/home/deploy", "app/")).toBe("/home/deploy/app/");
    expect(confineSftpPath("/home/deploy", "")).toBe("/home/deploy");
    // A client absolute path is treated as relative to root, not the real FS.
    expect(confineSftpPath("/home/deploy", "/etc/passwd")).toBe(
      "/home/deploy/etc/passwd"
    );
  });

  it("rejects escapes above a non-root root", () => {
    expect(() => confineSftpPath("/home/deploy", "../../etc/passwd")).toThrow(
      PathError
    );
  });
});

describe("normalizeS3Key", () => {
  it("strips leading slash and rejects traversal", () => {
    expect(normalizeS3Key("a/b.txt")).toBe("a/b.txt");
    expect(normalizeS3Key("/a/b.txt")).toBe("a/b.txt");
    expect(() => normalizeS3Key("a/../b")).toThrow(PathError);
  });

  it("preserves a trailing slash only when allowDir", () => {
    expect(normalizeS3Key("a/b/", true)).toBe("a/b/");
    expect(() => normalizeS3Key("a/b/")).toThrow(PathError);
  });
});

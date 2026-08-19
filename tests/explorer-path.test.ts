import { describe, expect, it } from "bun:test";
import {
  confineSftpPath,
  dirname,
  isWithin,
  joinPath,
  moveDestination,
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

describe("joinPath", () => {
  it("treats an empty dir as the root", () => {
    expect(joinPath("", "a.txt")).toBe("a.txt");
    expect(joinPath("a/b/", "c.txt")).toBe("a/b/c.txt");
    // A dir without the conventional trailing slash still joins cleanly.
    expect(joinPath("a/b", "c.txt")).toBe("a/b/c.txt");
  });
});

describe("dirname", () => {
  it("returns the parent with a trailing slash, or the root", () => {
    expect(dirname("a/b/c.txt")).toBe("a/b/");
    expect(dirname("a/b/")).toBe("a/");
    expect(dirname("a.txt")).toBe("");
  });
});

describe("moveDestination", () => {
  it("keeps the entry name and its folder-ness", () => {
    expect(moveDestination("a/b/c.txt", "d/")).toBe("d/c.txt");
    expect(moveDestination("a/b/", "d/")).toBe("d/b/");
    // Dropping onto the root breadcrumb.
    expect(moveDestination("a/b/c.txt", "")).toBe("c.txt");
    expect(moveDestination("a/b/", "")).toBe("b/");
  });
});

describe("isWithin", () => {
  it("detects a path inside a directory", () => {
    expect(isWithin("a/b/c.txt", "a/b/")).toBe(true);
    expect(isWithin("a/b/", "a/b/")).toBe(true);
    expect(isWithin("a/bc/d.txt", "a/b/")).toBe(false);
    // The root is not treated as a container: moving to the root is always
    // allowed, including for a folder that currently sits at the root.
    expect(isWithin("a/b/", "")).toBe(false);
  });
});

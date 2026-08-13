import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import { readTextFile, writeTextFile } from "@/lib/explorer/text";
import type { ExplorerEntry, StorageBackend } from "@/lib/explorer/types";
import { MAX_EDITABLE_BYTES } from "@/lib/validation";

// A backend serving one in-memory file. Only the members the text helpers touch
// are implemented; the rest throw so an accidental call is loud.
function fakeBackend(bytes: Buffer, reportedSize = bytes.length) {
  const written: Buffer[] = [];
  const unused = () => {
    throw new Error("not implemented");
  };
  const backend: StorageBackend = {
    async stat() {
      return {
        name: "file.txt",
        path: "file.txt",
        type: "file",
        sizeBytes: reportedSize,
      } satisfies ExplorerEntry;
    },
    async readStream() {
      return Readable.from([bytes]);
    },
    async writeStream(_path, body) {
      for await (const chunk of body) written.push(Buffer.from(chunk));
    },
    downloadTarget: unused,
    list: unused,
    remove: unused,
    mkdir: unused,
    rename: unused,
  };
  return { backend, written: () => Buffer.concat(written) };
}

describe("readTextFile", () => {
  it("reads UTF-8 text and reports LF line endings", async () => {
    const { backend } = fakeBackend(Buffer.from("a\nb\n", "utf8"));
    const result = await readTextFile(backend, "file.txt");
    expect(result).toEqual({ ok: true, content: "a\nb\n", eol: "lf" });
  });

  it("detects CRLF files so a save doesn't rewrite every line", async () => {
    const { backend } = fakeBackend(Buffer.from("a\r\nb\r\n", "utf8"));
    const result = await readTextFile(backend, "file.txt");
    expect(result).toMatchObject({ ok: true, eol: "crlf" });
  });

  it("keeps a leading BOM in the content so it round-trips", async () => {
    const { backend } = fakeBackend(Buffer.from("﻿a", "utf8"));
    const result = await readTextFile(backend, "file.txt");
    expect(result).toMatchObject({ ok: true, content: "﻿a" });
  });

  it("rejects files containing NUL bytes", async () => {
    const { backend } = fakeBackend(Buffer.from([0x61, 0x00, 0x62]));
    expect(await readTextFile(backend, "file.bin")).toEqual({
      ok: false,
      reason: "binary",
    });
  });

  it("rejects invalid UTF-8", async () => {
    const { backend } = fakeBackend(Buffer.from([0xff, 0xfe, 0x41]));
    expect(await readTextFile(backend, "file.bin")).toEqual({
      ok: false,
      reason: "binary",
    });
  });

  it("rejects oversized files up front using stat", async () => {
    const { backend } = fakeBackend(
      Buffer.from("small"),
      MAX_EDITABLE_BYTES + 1
    );
    expect(await readTextFile(backend, "big.txt")).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("still rejects when stat under-reports the size", async () => {
    // stat can be missing, stale, or wrong (a file growing between calls); the
    // drain loop is the gate that actually holds.
    const { backend } = fakeBackend(
      Buffer.alloc(MAX_EDITABLE_BYTES + 10, 0x61),
      1
    );
    expect(await readTextFile(backend, "big.txt")).toEqual({
      ok: false,
      reason: "too-large",
    });
  });
});

describe("writeTextFile", () => {
  it("writes LF content verbatim", async () => {
    const { backend, written } = fakeBackend(Buffer.alloc(0));
    await writeTextFile(backend, "file.txt", "a\nb", "lf");
    expect(written().toString("utf8")).toBe("a\nb");
  });

  it("restores CRLF endings without doubling existing ones", async () => {
    const { backend, written } = fakeBackend(Buffer.alloc(0));
    await writeTextFile(backend, "file.txt", "a\nb\r\nc", "crlf");
    expect(written().toString("utf8")).toBe("a\r\nb\r\nc");
  });
});

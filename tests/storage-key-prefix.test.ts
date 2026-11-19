import { describe, expect, it } from "vitest";
import { normalizeKeyPrefix } from "@/lib/validation";

// The key prefix an environment's storage connection is confined to. The
// form sends whatever was typed; the service stores only the normalised form
// (no leading "/", one trailing "/"), or null for the whole bucket, and
// refuses anything that could name a key outside it.

describe("normalizeKeyPrefix", () => {
  it("treats blank as the whole bucket", () => {
    expect(normalizeKeyPrefix("")).toEqual({ ok: true, prefix: null });
    expect(normalizeKeyPrefix("   ")).toEqual({ ok: true, prefix: null });
    expect(normalizeKeyPrefix("/")).toEqual({ ok: true, prefix: null });
    expect(normalizeKeyPrefix(null)).toEqual({ ok: true, prefix: null });
    expect(normalizeKeyPrefix(undefined)).toEqual({ ok: true, prefix: null });
  });

  it("trims, strips leading slashes and adds one trailing slash", () => {
    expect(normalizeKeyPrefix("team-a")).toEqual({
      ok: true,
      prefix: "team-a/",
    });
    expect(normalizeKeyPrefix("  /team-a/uploads  ")).toEqual({
      ok: true,
      prefix: "team-a/uploads/",
    });
    expect(normalizeKeyPrefix("//team-a/")).toEqual({
      ok: true,
      prefix: "team-a/",
    });
    expect(normalizeKeyPrefix("team a/ü-files/")).toEqual({
      ok: true,
      prefix: "team a/ü-files/",
    });
  });

  it.each([
    ["..", "a parent segment"],
    ["team-a/..", "a trailing parent segment"],
    ["team-a/../team-b", "an inner parent segment"],
    [".", "a current segment"],
    ["team-a/./b", "an inner current segment"],
    ["team-a//b", "an empty segment"],
    ["team-a//", "a doubled trailing slash"],
    ["team-a\\b", "a backslash"],
    ["..\\team-b", "a backslash parent"],
    ["team-a/\u0000b", "a NUL"],
    ["team-a/\nb", "a newline"],
    ["team-a/\u007fb", "DEL"],
    ["team-a/\u0085b", "a C1 control"],
    ["team-a%2Fb", "an encoded slash"],
    ["team-a%2fb", "an encoded slash, lower case"],
    ["team-a%5Cb", "an encoded backslash"],
    ["%2e%2e/team-b", "encoded dots"],
    ["team-a/%2E", "an encoded dot"],
    ["team-a/%252e%252e", "double-encoded dots"],
    ["．．/team-b", "fullwidth dots"],
    ["team-a／b", "a fullwidth slash"],
  ])("rejects %j (%s)", (input) => {
    expect(normalizeKeyPrefix(input)).toEqual({ ok: false });
  });

  it("rejects a prefix longer than an S3 key may be", () => {
    expect(normalizeKeyPrefix(`${"a".repeat(1100)}/`)).toEqual({ ok: false });
  });
});

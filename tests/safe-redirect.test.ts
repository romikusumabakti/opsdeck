import { describe, expect, it } from "bun:test";
import { safeRedirect } from "@/lib/safe-redirect";

describe("safeRedirect", () => {
  it("passes through root-relative paths", () => {
    expect(safeRedirect("/account")).toBe("/account");
    expect(safeRedirect("/projects/abc?tab=logs#top")).toBe(
      "/projects/abc?tab=logs#top"
    );
  });

  it("falls back when there is no target", () => {
    expect(safeRedirect(undefined)).toBe("/");
    expect(safeRedirect(null)).toBe("/");
    expect(safeRedirect("")).toBe("/");
  });

  it("rejects absolute URLs", () => {
    expect(safeRedirect("https://evil.example/login")).toBe("/");
    expect(safeRedirect("http://evil.example")).toBe("/");
    expect(safeRedirect("javascript:alert(1)")).toBe("/");
    expect(safeRedirect("data:text/html,<script>")).toBe("/");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeRedirect("//evil.example")).toBe("/");
    expect(safeRedirect("/\\evil.example")).toBe("/");
  });

  it("rejects control characters used to smuggle a scheme", () => {
    expect(safeRedirect("/\nhttps://evil.example")).toBe("/");
    expect(safeRedirect("/\tfoo")).toBe("/");
    expect(safeRedirect("/\x7ffoo")).toBe("/");
  });

  it("honours a custom fallback", () => {
    expect(safeRedirect("https://evil.example", "/sign-in")).toBe("/sign-in");
  });
});

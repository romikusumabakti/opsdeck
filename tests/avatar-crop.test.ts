import { describe, expect, it } from "bun:test";
import { centerOffset, clampOffset, cropLayout, zoomOffset } from "@/lib/avatar-crop";

const VIEW = 256;

describe("avatar crop geometry", () => {
  it("scales so the shorter side exactly covers the viewport at zoom 1", () => {
    const l = cropLayout({ width: 1000, height: 500 }, 1, VIEW);
    expect(l.height).toBe(VIEW);
    expect(l.width).toBe(512);
    expect(cropLayout({ width: 1000, height: 500 }, 2, VIEW).height).toBe(512);
  });

  it("centers the image, including on the long axis", () => {
    const l = cropLayout({ width: 1000, height: 500 }, 1, VIEW);
    expect(centerOffset(l, VIEW)).toEqual({ x: -128, y: 0 });
  });

  it("clamps so the viewport is always covered", () => {
    const l = cropLayout({ width: 1000, height: 500 }, 1, VIEW);
    expect(clampOffset({ x: 50, y: 50 }, l, VIEW)).toEqual({ x: 0, y: 0 });
    expect(clampOffset({ x: -900, y: -900 }, l, VIEW)).toEqual({ x: -256, y: 0 });
  });

  it("treats a legitimate 0,0 offset as a real position", () => {
    const l = cropLayout({ width: 500, height: 500 }, 2, VIEW);
    expect(clampOffset({ x: 0, y: 0 }, l, VIEW)).toEqual({ x: 0, y: 0 });
  });

  it("keeps the viewport centre fixed when zooming", () => {
    const nat = { width: 800, height: 800 };
    const a = cropLayout(nat, 1, VIEW);
    const b = cropLayout(nat, 2, VIEW);
    expect(zoomOffset(centerOffset(a, VIEW), a, b, VIEW)).toEqual(centerOffset(b, VIEW));
  });

  it("re-clamps when zooming out from an edge", () => {
    const nat = { width: 800, height: 800 };
    const a = cropLayout(nat, 4, VIEW);
    const b = cropLayout(nat, 1, VIEW);
    expect(zoomOffset({ x: -768, y: -768 }, a, b, VIEW)).toEqual({ x: 0, y: 0 });
  });
});

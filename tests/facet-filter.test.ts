import { describe, expect, it } from "vitest";
import {
  facetFilterFn,
  parseFacetParam,
  serializeFacetParam,
} from "@/lib/facet-filter";

const row = (value: unknown) => ({ getValue: () => value });

describe("facetFilterFn", () => {
  it("passes every row when no value is selected", () => {
    expect(facetFilterFn(row("failed"), "status", [])).toBe(true);
  });
  it("matches when the cell value is one of the selected values", () => {
    expect(facetFilterFn(row("failed"), "status", ["failed", "success"])).toBe(
      true
    );
    expect(facetFilterFn(row("started"), "status", ["failed"])).toBe(false);
  });
  it("stringifies the cell value", () => {
    expect(facetFilterFn(row(7), "n", ["7"])).toBe(true);
  });
});

describe("facet URL param", () => {
  it("parses a comma list, dropping blanks and duplicates", () => {
    expect(parseFacetParam("a,b,,a")).toEqual(["a", "b"]);
  });
  it("parses missing or empty to an empty list", () => {
    expect(parseFacetParam(null)).toEqual([]);
    expect(parseFacetParam("")).toEqual([]);
  });
  it("serializes to a comma list, empty for no values", () => {
    expect(serializeFacetParam(["a", "b"])).toBe("a,b");
    expect(serializeFacetParam([])).toBe("");
  });
  it("round-trips", () => {
    expect(parseFacetParam(serializeFacetParam(["x", "y"]))).toEqual([
      "x",
      "y",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { locationsOverlap } from "@/lib/restricted-targets";
import { sameS3Bucket } from "@/lib/validation";

// Whether a bucket location reaches into the instance backup destination,
// and whether two endpoints name the same place. Every spelling of one
// endpoint is the same place (sameS3Bucket), and the restriction itself
// does not lean on the endpoint at all: the same bucket name with an
// overlapping prefix is the backup destination wherever it is served from
// (DNS aliases and IP literals can't be enumerated).

const BASE = {
  endpoint: "https://objects.example.test",
  bucket: "panel-dumps",
};

describe("sameS3Bucket", () => {
  it.each([
    ["host case", "https://OBJECTS.Example.TEST"],
    ["trailing slashes", "https://objects.example.test//"],
    ["a trailing dot", "https://objects.example.test."],
    ["the default https port", "https://objects.example.test:443"],
    ["the default http port", "http://objects.example.test:80"],
    ["another scheme", "http://objects.example.test"],
    ["userinfo", "https://someone:pw@objects.example.test"],
    ["a query", "https://objects.example.test/?x-id=1"],
    ["a fragment", "https://objects.example.test/#top"],
    ["a bare path", "https://objects.example.test/"],
    ["surrounding blanks", "  https://objects.example.test  "],
  ])("treats %s as the same endpoint", (_label, endpoint) => {
    expect(sameS3Bucket(BASE, { endpoint, bucket: "panel-dumps" })).toBe(true);
  });

  it("keeps other hosts, ports, paths and buckets apart", () => {
    for (const endpoint of [
      "https://other.example.test",
      "https://objects.example.test:9000",
      "https://objects.example.test/tenant-a",
    ]) {
      expect(sameS3Bucket(BASE, { endpoint, bucket: "panel-dumps" })).toBe(
        false
      );
    }
    expect(
      sameS3Bucket(BASE, { endpoint: BASE.endpoint, bucket: "app-files" })
    ).toBe(false);
  });
});

describe("locationsOverlap", () => {
  const destination = { ...BASE, keyPrefix: "panel/" };

  it.each([
    ["a trailing dot", "https://objects.example.test."],
    ["the default port", "https://objects.example.test:443"],
    ["userinfo", "https://u@objects.example.test"],
    ["a query", "https://objects.example.test?a=b"],
    ["a bare path", "https://objects.example.test/"],
    ["another scheme", "http://objects.example.test"],
  ])("sees through %s", (_label, endpoint) => {
    expect(
      locationsOverlap(
        { endpoint, bucket: "panel-dumps", keyPrefix: null },
        destination
      )
    ).toBe(true);
  });

  it("restricts the same bucket and prefix on any endpoint", () => {
    for (const endpoint of [
      "https://alias.example.test",
      "https://192.0.2.44:9000",
      "http://[2001:db8::1]",
    ]) {
      expect(
        locationsOverlap(
          { endpoint, bucket: "panel-dumps", keyPrefix: "panel/2026/" },
          destination
        )
      ).toBe(true);
      expect(
        locationsOverlap(
          { endpoint, bucket: "panel-dumps", keyPrefix: null },
          destination
        )
      ).toBe(true);
    }
  });

  it("compares bucket names and prefixes in their stored form", () => {
    expect(
      locationsOverlap(
        { ...BASE, bucket: " Panel-Dumps ", keyPrefix: "/panel" },
        destination
      )
    ).toBe(true);
  });

  it("leaves other buckets and disjoint prefixes alone", () => {
    expect(
      locationsOverlap(
        { ...BASE, bucket: "app-files", keyPrefix: null },
        destination
      )
    ).toBe(false);
    expect(
      locationsOverlap(
        { ...BASE, endpoint: "https://alias.example.test", keyPrefix: "app/" },
        destination
      )
    ).toBe(false);
    // A sibling prefix sharing the first letters is not inside.
    expect(
      locationsOverlap({ ...BASE, keyPrefix: "panel-old/" }, destination)
    ).toBe(false);
  });
});

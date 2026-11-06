import { describe, expect, it } from "vitest";
import {
  domainInputSchema,
  domainLabelSchema,
  externalHostnameSchema,
  hostnameFor,
  isFqdn,
  originHostSchema,
} from "@/lib/domains/validation";

describe("domainLabelSchema", () => {
  it.each(["hris-staging", "a", "x1", "a".repeat(63)])(
    "accepts %s",
    (label) => {
      expect(domainLabelSchema.safeParse(label).success).toBe(true);
    }
  );

  it.each(["a.b", "-x", "x-", "HRIS", "a".repeat(64), "", "a_b"])(
    "rejects %s",
    (label) => {
      expect(domainLabelSchema.safeParse(label).success).toBe(false);
    }
  );
});

describe("hostnameFor", () => {
  it("joins the label and the zone name", () => {
    expect(hostnameFor("hris-staging", "example.net")).toBe(
      "hris-staging.example.net"
    );
  });
});

describe("external hostnames", () => {
  it("normalises to lowercase and trims", () => {
    expect(externalHostnameSchema.parse("  App.Example.COM ")).toBe(
      "app.example.com"
    );
  });

  it("accepts any depth of labels", () => {
    expect(isFqdn("a.b.c.example.com")).toBe(true);
  });

  it.each([
    "localhost",
    "-a.example.com",
    "a..example.com",
    "a.example.com.",
    "exa mple.com",
    "https://a.example.com",
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`,
  ])("rejects %s", (hostname) => {
    expect(externalHostnameSchema.safeParse(hostname).success).toBe(false);
  });
});

describe("originHostSchema", () => {
  it.each(["localhost", "10.0.0.5", "host.internal"])("accepts %s", (host) => {
    expect(originHostSchema.safeParse(host).success).toBe(true);
  });

  it.each(["http://x", "x:80", "x/y", " "])("rejects %s", (host) => {
    expect(originHostSchema.safeParse(host).success).toBe(false);
  });
});

describe("domainInputSchema", () => {
  const zoneId = "0197f3a0-1b2c-7def-8000-0123456789a1";

  it("accepts a tunnel binding, public or with a policy", () => {
    for (const accessPolicyId of ["pol-1", null]) {
      expect(
        domainInputSchema.safeParse({
          kind: "tunnel",
          zoneId,
          label: "hris",
          accessPolicyId,
          entryPort: 8080,
        }).success
      ).toBe(true);
    }
  });

  it("rejects ports outside 1-65535 and unknown fields", () => {
    const base = {
      kind: "tunnel",
      zoneId,
      label: "hris",
      accessPolicyId: null,
    };
    for (const entryPort of [0, 65_536, 1.5]) {
      expect(domainInputSchema.safeParse({ ...base, entryPort }).success).toBe(
        false
      );
    }
    expect(
      domainInputSchema.safeParse({ ...base, entryPort: 80, extra: 1 }).success
    ).toBe(false);
  });
});

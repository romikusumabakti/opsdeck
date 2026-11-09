import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudflareApiError,
  deleteAccessApp,
  deleteDnsRecord,
  type TunnelConfig,
  UnsafeTunnelConfigError,
  withoutIngressRoute,
} from "@/lib/cloudflare/api";

const creds = { accountId: "a".repeat(32), apiToken: "SECRET-TOKEN-VALUE" };
const base = "https://api.cloudflare.com/client/v4";

type Call = { url: string; method: string };
let calls: Call[];
let responses: Response[];

function ok(result: unknown) {
  return new Response(JSON.stringify({ success: true, errors: [], result }), {
    status: 200,
  });
}

function failure(status: number, code: number, message: string) {
  return new Response(
    JSON.stringify({
      success: false,
      errors: [{ code, message }],
      result: null,
    }),
    { status }
  );
}

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const config: TunnelConfig = {
  originRequest: { noTLSVerify: true },
  ingress: [
    { hostname: "a.example.com", service: "http://localhost:1" },
    { hostname: "b.example.com", service: "http://localhost:2" },
    { hostname: "*.example.com", service: "http://localhost:3" },
    { service: "http_status:404" },
  ],
};

describe("withoutIngressRoute", () => {
  it("removes the hostname and keeps the rest in order, catch-all last", () => {
    const result = withoutIngressRoute(config, "b.example.com");
    expect(result.removed).toBe(true);
    expect(result.config.ingress).toEqual([
      { hostname: "a.example.com", service: "http://localhost:1" },
      { hostname: "*.example.com", service: "http://localhost:3" },
      { service: "http_status:404" },
    ]);
    expect(result.config.originRequest).toEqual({ noTLSVerify: true });
    expect(config.ingress).toHaveLength(4);
  });

  it("matches the hostname case-insensitively", () => {
    const result = withoutIngressRoute(config, "A.Example.COM");
    expect(result.removed).toBe(true);
    expect(result.config.ingress.map((r) => r.hostname)).toEqual([
      "b.example.com",
      "*.example.com",
      undefined,
    ]);
  });

  it("returns removed false and the identical config for an absent hostname", () => {
    const result = withoutIngressRoute(config, "zzz.example.com");
    expect(result.removed).toBe(false);
    expect(result.config).toEqual(config);
  });

  it("never removes the catch-all rule", () => {
    const result = withoutIngressRoute(config, "http_status:404");
    expect(result.removed).toBe(false);
    expect(result.config.ingress.at(-1)).toEqual({
      service: "http_status:404",
    });
  });

  it("refuses a config without a catch-all", () => {
    expect(() =>
      withoutIngressRoute(
        { ingress: [{ hostname: "a.example.com", service: "x" }] },
        "a.example.com"
      )
    ).toThrow(UnsafeTunnelConfigError);
  });
});

describe("deleteDnsRecord", () => {
  it("deletes the record", async () => {
    responses.push(ok({ id: "rec-1" }));
    await expect(deleteDnsRecord(creds, "zone 1", "rec-1")).resolves.toBe(
      "deleted"
    );
    expect(calls).toEqual([
      { url: `${base}/zones/zone%201/dns_records/rec-1`, method: "DELETE" },
    ]);
  });

  it("maps 404 to absent", async () => {
    responses.push(failure(404, 81044, "Record does not exist."));
    await expect(deleteDnsRecord(creds, "zone", "rec-1")).resolves.toBe(
      "absent"
    );
  });

  it("throws CloudflareApiError on other failures", async () => {
    responses.push(failure(403, 10000, "Authentication error"));
    await expect(deleteDnsRecord(creds, "zone", "rec-1")).rejects.toThrow(
      CloudflareApiError
    );
  });
});

describe("deleteAccessApp", () => {
  it("deletes the app", async () => {
    responses.push(ok({ id: "app-1" }));
    await expect(
      deleteAccessApp(creds, creds.accountId, "app-1")
    ).resolves.toBe("deleted");
    expect(calls).toEqual([
      {
        url: `${base}/accounts/${creds.accountId}/access/apps/app-1`,
        method: "DELETE",
      },
    ]);
  });

  it("maps 404 to absent", async () => {
    responses.push(failure(404, 12006, "Access app not found"));
    await expect(
      deleteAccessApp(creds, creds.accountId, "app-1")
    ).resolves.toBe("absent");
  });

  it("throws CloudflareApiError on other failures", async () => {
    responses.push(failure(500, 1000, "Internal error"));
    await expect(
      deleteAccessApp(creds, creds.accountId, "app-1")
    ).rejects.toThrow(CloudflareApiError);
  });
});

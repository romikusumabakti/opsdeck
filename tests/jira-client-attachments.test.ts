import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentTooLargeError, JiraClient } from "@/lib/jira/client";

const cloud = new JiraClient({
  baseUrl: "https://acme.atlassian.net/",
  flavor: "cloud",
  email: "bot@example.com",
  token: "secret-token",
});

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    })
  );
  return calls;
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JiraClient.getAttachments", () => {
  it("reads the issue's attachment field and normalizes it", async () => {
    const calls = mockFetch(() =>
      Response.json({
        id: "100",
        key: "KST-1",
        fields: {
          attachment: [
            {
              id: "10001",
              filename: "spec.pdf",
              mimeType: "application/pdf",
              size: 1234,
              created: "2026-11-01T10:00:00.000+0700",
            },
            { id: 10002, filename: "raw.bin" },
          ],
        },
      })
    );
    const list = await cloud.getAttachments("KST-1");
    expect(list).toEqual([
      {
        id: "10001",
        filename: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1234,
        created: "2026-11-01T10:00:00.000+0700",
      },
      {
        id: "10002",
        filename: "raw.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
        created: null,
      },
    ]);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/rest/api/3/issue/KST-1");
    expect(url.searchParams.get("fields")).toBe("attachment");
  });

  it("returns an empty list when the field is absent", async () => {
    mockFetch(() => Response.json({ id: "1", key: "KST-1", fields: {} }));
    expect(await cloud.getAttachments("KST-1")).toEqual([]);
  });
});

describe("JiraClient.downloadAttachment", () => {
  it("follows the media redirect without re-sending Authorization to another host", async () => {
    const calls = mockFetch((url) => {
      if (url.startsWith("https://acme.atlassian.net/")) {
        return new Response(null, {
          status: 303,
          headers: {
            Location: "https://api.media.atlassian.com/file/x?token=t",
          },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "application/pdf; charset=binary" },
      });
    });
    const result = await cloud.downloadAttachment("10001");
    expect(result.mime).toBe("application/pdf");
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      "https://acme.atlassian.net/rest/api/3/attachment/content/10001"
    );
    expect(header(calls[0]?.init ?? {}, "Authorization")).toMatch(/^Basic /);
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(header(calls[1]?.init ?? {}, "Authorization")).toBeUndefined();
  });

  it("keeps Authorization on a same-origin redirect", async () => {
    const calls = mockFetch((url) =>
      url.includes("/rest/api/3/")
        ? new Response(null, {
            status: 302,
            headers: { Location: "/secure/attachment/10001/a.png" },
          })
        : new Response(new Uint8Array([9]), {
            headers: { "Content-Type": "image/png" },
          })
    );
    await cloud.downloadAttachment("10001");
    expect(calls[1]?.url).toBe(
      "https://acme.atlassian.net/secure/attachment/10001/a.png"
    );
    expect(header(calls[1]?.init ?? {}, "Authorization")).toMatch(/^Basic /);
  });

  it("refuses a body whose declared length exceeds the cap", async () => {
    mockFetch(
      () =>
        new Response(new Uint8Array(10), {
          headers: { "Content-Length": "999999999" },
        })
    );
    await expect(cloud.downloadAttachment("1")).rejects.toBeInstanceOf(
      AttachmentTooLargeError
    );
  });

  it("stops reading once the streamed body passes the cap", async () => {
    mockFetch(() => new Response(new Uint8Array(64)));
    await expect(
      cloud.downloadAttachment("1", { maxBytes: 16 })
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
  });

  it("refuses a redirect from https to http", async () => {
    mockFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://evil.example/x" },
        })
    );
    await expect(cloud.downloadAttachment("1")).rejects.toThrow(/insecure/);
  });
});

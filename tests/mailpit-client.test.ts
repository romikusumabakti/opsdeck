import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  deleteMailpitMessages,
  describeMailpitStatus,
  getMailpitMessage,
  listMailpitMessages,
  type MailpitConfig,
  MailpitError,
  mailpitAuthHeaders,
  mailpitEventsUrl,
  mailpitUrl,
} from "@/lib/mailpit/client";
import { mailMessageSchema, messagesPageSchema } from "@/lib/mailpit/schemas";
import messageFixture from "./fixtures/mailpit-message.json";
import messagesFixture from "./fixtures/mailpit-messages.json";

const cfg: MailpitConfig = {
  url: "https://mail.test/mailpit",
  username: "qa",
  password: "secret",
};

describe("mailpitUrl", () => {
  it("joins onto a bare origin", () => {
    expect(mailpitUrl("http://10.0.0.5:8025", "api/v1/info")).toBe(
      "http://10.0.0.5:8025/api/v1/info"
    );
  });

  it("keeps a webroot without a trailing slash", () => {
    expect(mailpitUrl("https://mail.test/mailpit", "api/v1/info")).toBe(
      "https://mail.test/mailpit/api/v1/info"
    );
  });

  it("keeps a webroot with a trailing slash and a leading-slash path", () => {
    expect(mailpitUrl("https://mail.test/mailpit/", "/api/v1/info")).toBe(
      "https://mail.test/mailpit/api/v1/info"
    );
  });

  it("encodes params and drops empty ones", () => {
    expect(
      mailpitUrl("https://mail.test", "api/v1/search", {
        query: "to:a@b.c is:unread",
        start: 0,
        limit: 50,
        tz: "",
        skip: undefined,
      })
    ).toBe(
      "https://mail.test/api/v1/search?query=to%3Aa%40b.c+is%3Aunread&start=0&limit=50"
    );
  });
});

describe("mailpitEventsUrl", () => {
  it("maps http to ws", () => {
    expect(mailpitEventsUrl("http://10.0.0.5:8025")).toBe(
      "ws://10.0.0.5:8025/api/events"
    );
  });

  it("maps https to wss and keeps the webroot", () => {
    expect(mailpitEventsUrl("https://mail.test/mailpit")).toBe(
      "wss://mail.test/mailpit/api/events"
    );
  });
});

describe("mailpitAuthHeaders", () => {
  it("is empty without a username", () => {
    expect(
      mailpitAuthHeaders({
        url: "http://x.test",
        username: null,
        password: "p",
      })
    ).toEqual({});
  });

  it("builds Basic auth", () => {
    expect(mailpitAuthHeaders(cfg)).toEqual({
      Authorization: "Basic cWE6c2VjcmV0",
    });
  });
});

describe("describeMailpitStatus", () => {
  it("explains auth failures", () => {
    expect(describeMailpitStatus(401, "Unauthorized")).toContain(
      "authentication failed"
    );
  });

  it("falls back to the status line", () => {
    expect(describeMailpitStatus(500, "Internal Server Error")).toBe(
      "Mailpit responded 500 Internal Server Error"
    );
  });
});

describe("schemas", () => {
  it("normalises null address lists to []", () => {
    const page = messagesPageSchema.parse(messagesFixture);
    expect(page.messages).toHaveLength(2);
    expect(page.messages[1]?.To).toEqual([]);
    expect(page.messages[1]?.From).toBeNull();
  });

  it("parses a full message", () => {
    const message = mailMessageSchema.parse(messageFixture);
    expect(message.Cc).toEqual([]);
    expect(message.Inline[0]?.ContentID).toBe("logo@app");
    expect(message.Attachments[0]?.FileName).toBe("invoice.pdf");
  });
});

describe("requests", () => {
  afterEach(() => {
    mock.restore();
  });

  it("uses the search endpoint with auth when a query is given", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(messagesFixture)
    );
    const page = await listMailpitMessages(cfg, {
      query: "is:unread",
      start: 50,
    });
    expect(page.messages_count).toBe(2);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://mail.test/mailpit/api/v1/search?start=50&limit=50&query=is%3Aunread"
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Basic cWE6c2VjcmV0"
    );
  });

  it("uses the messages endpoint without a query", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(messagesFixture)
    );
    await listMailpitMessages(cfg, { query: "", start: 0 });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://mail.test/mailpit/api/v1/messages?start=0&limit=50"
    );
  });

  it("maps 401 to a MailpitError carrying the status", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401, statusText: "Unauthorized" })
    );
    const err = await getMailpitMessage(cfg, "abc").catch((e) => e);
    expect(err).toBeInstanceOf(MailpitError);
    expect(err.status).toBe(401);
  });

  it("maps network failures through describeFetchError", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })
    );
    const err = await getMailpitMessage(cfg, "abc").catch((e) => e);
    expect(err).toBeInstanceOf(MailpitError);
    expect(err.message).toBe("ECONNREFUSED");
  });

  it("rejects malformed JSON shapes", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ nope: 1 }));
    const err = await getMailpitMessage(cfg, "abc").catch((e) => e);
    expect(err).toBeInstanceOf(MailpitError);
    expect(err.message).toBe("Unexpected response from Mailpit");
  });

  it("never turns an empty selection into delete-all", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok")
    );
    await expect(deleteMailpitMessages(cfg, [])).rejects.toBeInstanceOf(
      MailpitError
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends an explicit empty IDs list only for 'all'", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok")
    );
    await deleteMailpitMessages(cfg, "all");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mail.test/mailpit/api/v1/messages");
    expect(init.method).toBe("DELETE");
    expect(init.redirect).toBe("error");
    expect(init.body).toBe('{"IDs":[]}');
  });
});

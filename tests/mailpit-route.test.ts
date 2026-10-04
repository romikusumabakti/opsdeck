import { describe, expect, it } from "bun:test";
import { MailpitError } from "@/lib/mailpit/client";
import {
  attachmentDisposition,
  mailpitErrorResponse,
} from "@/lib/mailpit/download";

describe("attachmentDisposition", () => {
  it("is always an attachment with an RFC 5987 filename", () => {
    expect(attachmentDisposition("invoice.pdf")).toBe(
      "attachment; filename*=UTF-8''invoice.pdf"
    );
  });

  it("encodes non-ASCII and header-breaking characters", () => {
    expect(attachmentDisposition('fac"tura\r\nñ.pdf')).toBe(
      "attachment; filename*=UTF-8''fac%22tura%0D%0A%C3%B1.pdf"
    );
  });
});

describe("mailpitErrorResponse", () => {
  it("passes 404 through", () => {
    expect(mailpitErrorResponse(new MailpitError("gone", 404)).status).toBe(
      404
    );
  });

  it("maps other Mailpit failures to 502", async () => {
    const res = mailpitErrorResponse(new MailpitError("ECONNREFUSED"));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("ECONNREFUSED");
  });

  it("hides unexpected errors behind 500", async () => {
    const res = mailpitErrorResponse(new Error("db password is hunter2"));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("hunter2");
  });
});

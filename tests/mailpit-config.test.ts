import { describe, expect, it } from "bun:test";
import { shouldReuseStoredPassword } from "@/lib/mailpit/config";

const stored = {
  url: "https://mail.test/",
  username: "qa",
  password: "s3cret",
};

describe("shouldReuseStoredPassword", () => {
  it("reuses it for the same URL, a username, and a blank password", () => {
    expect(
      shouldReuseStoredPassword(
        { url: "https://mail.test/", username: "qa" },
        stored
      )
    ).toBe(true);
  });

  it("never sends the stored password to a different URL", () => {
    expect(
      shouldReuseStoredPassword(
        { url: "https://evil.test/", username: "qa" },
        stored
      )
    ).toBe(false);
  });

  it("does not reuse when a password was typed", () => {
    expect(
      shouldReuseStoredPassword(
        { url: "https://mail.test/", username: "qa", password: "new" },
        stored
      )
    ).toBe(false);
  });

  it("does not reuse without a username or without a stored row", () => {
    expect(
      shouldReuseStoredPassword(
        { url: "https://mail.test/", username: null },
        stored
      )
    ).toBe(false);
    expect(
      shouldReuseStoredPassword(
        { url: "https://mail.test/", username: "qa" },
        null
      )
    ).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";
import { describeFetchError } from "@/lib/fetch-error";

describe("describeFetchError", () => {
  it("surfaces the first AggregateError cause with its code", () => {
    const err = new TypeError("fetch failed", {
      cause: {
        errors: [
          {
            code: "ECONNREFUSED",
            message: "connect ECONNREFUSED 10.0.0.5:8025",
          },
        ],
      },
    });
    expect(describeFetchError(err)).toBe(
      "ECONNREFUSED: connect ECONNREFUSED 10.0.0.5:8025"
    );
  });

  it("falls back to a bare cause code", () => {
    const err = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    expect(describeFetchError(err)).toBe("ENOTFOUND");
  });

  it("uses the error message when there is no cause", () => {
    expect(describeFetchError(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-errors", () => {
    expect(describeFetchError("nope")).toBe("nope");
  });
});

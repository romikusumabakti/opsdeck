import { describe, expect, it } from "vitest";
import { authGate } from "@/web/auth-gate";

const user = { user: { id: "u1" } };

describe("authGate", () => {
  // A dead session on a deep link keeps the locale and remembers the page, so
  // sign-in can come back to it.
  it("sends a signed-out deep link to sign-in, keeping locale and path", () => {
    const result = authGate({ pathname: "/id/servers/abc" }, null);
    expect(result).not.toBeNull();
    expect(result?.options.to).toBe("/$locale/sign-in");
    expect(result?.options.params).toEqual({ locale: "id" });
    expect(result?.options.search).toEqual({ redirect: "/servers/abc" });
  });

  it("remembers the locale root as /", () => {
    const result = authGate({ pathname: "/en" }, null);
    expect(result?.options.search).toEqual({ redirect: "/" });
  });

  it.each([
    "/id/sign-in",
    "/id/accept-invite/tok",
    "/en/setup",
    "/en/forgot-password",
    "/en/reset-password",
  ])("lets a signed-out visitor open %s", (pathname) => {
    expect(authGate({ pathname }, null)).toBeNull();
  });

  it("lets a signed-in user through", () => {
    expect(authGate({ pathname: "/id/servers" }, user)).toBeNull();
  });
});

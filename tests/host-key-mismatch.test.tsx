// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import {
  HostKeyReviewLink,
  isHostKeyMismatchFailure,
  isHostKeyMismatchFrame,
  serverPageHref,
} from "../components/host-key-mismatch";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ID = "0197f3a0-1b2c-7def-8000-000000000001";

describe("a changed host key in the terminal and the file explorer", () => {
  it("the terminal frame with the code is the host key refusal; other errors are not", () => {
    expect(isHostKeyMismatchFrame("hostKeyMismatch")).toBe(true);
    expect(isHostKeyMismatchFrame("SSH connection failed")).toBe(false);
    expect(isHostKeyMismatchFrame("Too many open terminals")).toBe(false);
  });

  it("an explorer listing refused with the code is; a generic failure or success is not", () => {
    expect(
      isHostKeyMismatchFailure({
        success: false,
        message: "The server's host key does not match…",
        code: "hostKeyMismatch",
      } as { success: boolean })
    ).toBe(true);
    expect(
      isHostKeyMismatchFailure({ success: false, message: "failed" } as {
        success: boolean;
      })
    ).toBe(false);
    expect(isHostKeyMismatchFailure({ success: true })).toBe(false);
  });

  it("links to the server page", async () => {
    expect(serverPageHref(ID)).toBe(`/servers/${ID}`);
    const el = document.createElement("div");
    const root = createRoot(el);
    await act(async () =>
      root.render(<HostKeyReviewLink serverId={ID}>Review</HostKeyReviewLink>)
    );
    expect(el.querySelector("a")?.getAttribute("href")).toBe(`/servers/${ID}`);
    act(() => root.unmount());
  });
});

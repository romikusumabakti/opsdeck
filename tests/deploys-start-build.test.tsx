// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const api = vi.hoisted(() => ({
  startComponentBuild: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/web/api/apps", () => ({
  startComponentBuild: api.startComponentBuild,
}));

import { StartBuildButton } from "../web/routes/$locale/_app/-components/env/deploys/deploys-client";

let root: Root;
let container: HTMLDivElement;

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages}>
          <StartBuildButton
            appKey="hris"
            componentKey="hris-be"
            branch="feature-x"
          />
        </IntlProvider>
      </QueryClientProvider>
    )
  );
}

function button(): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === messages.deploys.startBuild
  );
  if (!found) throw new Error("Start build button not found");
  return found;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Start build on the Deploys page", () => {
  it("starts a build of the target's branch", async () => {
    api.startComponentBuild.mockResolvedValue({ number: 12 });
    await mount();
    await act(async () => button().click());
    expect(api.startComponentBuild).toHaveBeenCalledWith(
      "hris",
      "hris-be",
      "feature-x"
    );
    expect(api.toast.success).toHaveBeenCalledWith("Build 12 started");
  });

  it("shows the refusal", async () => {
    api.startComponentBuild.mockRejectedValue(new Error("Forbidden"));
    await mount();
    await act(async () => button().click());
    expect(api.toast.error).toHaveBeenCalledWith("Forbidden");
    expect(button().disabled).toBe(false);
  });
});

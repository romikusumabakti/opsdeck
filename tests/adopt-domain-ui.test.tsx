// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// Settings → Domain: admins adopt a hostname Cloudflare already routes
// through a registered tunnel, under a disclosure, while there is no domain.

const ENV = "0197f3a0-1b2c-7def-8000-0123456789e1";
const TUNNEL = "0197f3a0-1b2c-7def-8000-0123456789c1";

const api = vi.hoisted(() => ({
  orgRole: "admin" as string,
  adopt: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ orgRole: api.orgRole }),
}));
vi.mock("@/web/api/environment-domains", () => ({
  adoptEnvironmentDomain: api.adopt,
  putEnvironmentDomain: vi.fn(),
  deleteEnvironmentDomain: vi.fn(),
  domainAccessPoliciesQuery: (id: string) => ({
    queryKey: ["policies", id],
    queryFn: async () => [],
  }),
}));
vi.mock("@/web/api/remote-tunnels", () => ({
  remoteTunnelsQuery: () => ({
    queryKey: ["remote-tunnels", "list"],
    queryFn: async () => [
      {
        id: TUNNEL,
        serverId: "s1",
        serverName: ".136",
        tunnelId: "cf-1",
        name: "dss-apps-136",
        originHost: "localhost",
        boundCount: 0,
      },
    ],
  }),
}));

import { ApiError } from "@/web/api/client";
import { AdoptDomainForm } from "../web/routes/$locale/_app/-components/env/settings/adopt-domain-form";
import { DomainTab } from "../web/routes/$locale/_app/-components/env/settings/domain-tab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.domains;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          {node}
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  api.orgRole = "admin";
});

const noDomain = { domain: null, zones: [], entryPort: null } as never;
const withDomain = {
  domain: { kind: "external", hostname: "a.example.com", provisioned: false },
  zones: [],
  entryPort: null,
} as never;

async function type(name: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(
    `input[name='${name}']`
  );
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Adopt an existing hostname", () => {
  it("is offered to admins only, and only while there is no domain", async () => {
    await render(<DomainTab environmentId={ENV} domain={noDomain} />);
    expect(container.textContent).toContain(t.adopt.title);
    act(() => root.unmount());
    container.remove();

    await render(<DomainTab environmentId={ENV} domain={withDomain} />);
    expect(container.textContent).not.toContain(t.adopt.title);
    act(() => root.unmount());
    container.remove();

    api.orgRole = "member";
    await render(<DomainTab environmentId={ENV} domain={noDomain} />);
    expect(container.textContent).not.toContain(t.adopt.title);
  });

  it("sends hostname, tunnel and service, and shows a refusal by its code", async () => {
    api.adopt.mockRejectedValue(
      new ApiError(422, "no record", "hostnameNotOnTunnel")
    );
    await render(<AdoptDomainForm environmentId={ENV} />);
    await vi.waitFor(() =>
      expect(
        container.querySelector("[role='combobox']")?.textContent
      ).toContain(t.adopt.tunnelPlaceholder)
    );
    await type("hostname", "Demo-Dms.dssconsulting.id");
    await type("service", "http://dms-web:80");
    // The tunnel select: pick the one registered tunnel.
    await act(async () =>
      container.querySelector<HTMLElement>("[role='combobox']")?.click()
    );
    const option = await vi.waitFor(() => {
      const found = [...document.querySelectorAll("[role='option']")].find(
        (o) => o.textContent?.includes("dss-apps-136")
      ) as HTMLElement | undefined;
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    await act(async () => option.click());
    await act(async () => container.querySelector("form")?.requestSubmit());
    await vi.waitFor(() =>
      expect(api.adopt).toHaveBeenCalledWith(ENV, {
        hostname: "demo-dms.dssconsulting.id",
        remoteTunnelId: TUNNEL,
        service: "http://dms-web:80",
      })
    );
    await vi.waitFor(() =>
      expect(api.toast.error).toHaveBeenCalledWith(t.errors.hostnameNotOnTunnel)
    );
  });

  it("shows a generic localized line for an unknown code, never the API's text", async () => {
    api.adopt.mockRejectedValue(
      new ApiError(500, "internal prose from the API", "somethingUnknown")
    );
    await render(<AdoptDomainForm environmentId={ENV} />);
    await vi.waitFor(() =>
      expect(
        container.querySelector("[role='combobox']")?.textContent
      ).toContain(t.adopt.tunnelPlaceholder)
    );
    await type("hostname", "demo-dms.dssconsulting.id");
    await type("service", "http://dms-web:80");
    await act(async () =>
      container.querySelector<HTMLElement>("[role='combobox']")?.click()
    );
    const option = await vi.waitFor(() => {
      const found = [...document.querySelectorAll("[role='option']")].find(
        (o) => o.textContent?.includes("dss-apps-136")
      ) as HTMLElement | undefined;
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    await act(async () => option.click());
    await act(async () => container.querySelector("form")?.requestSubmit());
    await vi.waitFor(() =>
      expect(api.toast.error).toHaveBeenCalledWith(t.adopt.failed)
    );
  });

  it("checks the service shape before sending", async () => {
    await render(<AdoptDomainForm environmentId={ENV} />);
    await type("hostname", "demo.dssconsulting.id");
    await type("service", "dms-web");
    await act(async () => container.querySelector("form")?.requestSubmit());
    await vi.waitFor(() =>
      expect(container.textContent).toContain(t.adopt.serviceInvalid)
    );
    expect(api.adopt).not.toHaveBeenCalled();
  });
});

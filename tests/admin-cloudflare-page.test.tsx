// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const ZONE_ID = "0123456789abcdef0123456789abcdef";

const api = vi.hoisted(() => ({ createZone: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin/cloudflare",
  useSearchParams: () => new URLSearchParams(),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/dialog-provider", () => ({
  useDialog: () => ({ confirm: vi.fn(), confirmTyping: vi.fn() }),
}));
// The account form has its own tests; here it only has to be there.
vi.mock("@/components/cloudflare-account-form", () => ({
  CloudflareAccountForm: () => <form aria-label="account" />,
}));
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ orgRole: "admin" }),
}));
vi.mock("@/web/api/cloudflare-account", () => ({
  getCloudflareAccountQuery: () => ({
    queryKey: ["cloudflare-account"],
    queryFn: () => ({ hasToken: true }),
  }),
  cloudflareTunnelsQuery: () => ({
    queryKey: ["cloudflare-account", "tunnels"],
    queryFn: () => [],
  }),
}));
vi.mock("@/web/api/remote-tunnels", () => ({
  remoteTunnelsQuery: () => ({
    queryKey: ["remote-tunnels"],
    queryFn: () => [],
  }),
  deleteRemoteTunnel: vi.fn(),
}));
vi.mock("@/web/api/tunnels", () => ({
  getCloudflareZonesQuery: () => ({
    queryKey: ["tunnels", "zones"],
    queryFn: () => [],
  }),
  getTunnelsQuery: () => ({
    queryKey: ["tunnels", "tunnels"],
    queryFn: () => [],
  }),
  deleteCloudflareZone: vi.fn(),
  deleteTunnel: vi.fn(),
  createCloudflareZone: api.createZone,
  updateCloudflareZone: vi.fn(),
  testCloudflareZone: vi.fn(),
}));

const { Route } = await import(
  "../web/routes/$locale/_app/admin.cloudflare.index"
);
const { CloudflareZoneForm } = await import(
  "@/components/cloudflare-zone-form"
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["cloudflare-account"], { hasToken: true });
  queryClient.setQueryData(["cloudflare-account", "tunnels"], []);
  queryClient.setQueryData(["remote-tunnels"], []);
  queryClient.setQueryData(
    ["tunnels", "zones"],
    [{ id: "z1", name: "example.com", zoneId: ZONE_ID, hasToken: false }]
  );
  queryClient.setQueryData(["tunnels", "tunnels"], []);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages}>
          {node}
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

const titles = () =>
  [...container.querySelectorAll("[data-slot='card-title']")].map(
    (el) => el.textContent
  );

const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label
  );

const input = (name: string) =>
  container.querySelector<HTMLInputElement>(`input[name='${name}']`);

async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  api.createZone.mockReset();
  api.createZone.mockResolvedValue({ success: true, message: "Saved" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("/admin/cloudflare", () => {
  it("renders Account, Zones and Tunnels, with Local tunnels collapsed under Advanced options", async () => {
    const Page = Route.options.component as React.ComponentType;
    await render(<Page />);

    expect(titles()).toEqual(["Account", "DNS zones", "Tunnels"]);
    expect(container.querySelector("#zones")).not.toBeNull();
    expect(container.textContent).toContain("example.com");
    expect(container.textContent).not.toContain("Local tunnels");

    const advanced = button("Advanced options");
    expect(advanced).toBeDefined();
    await act(async () => advanced?.click());
    expect(titles()).toEqual([
      "Account",
      "DNS zones",
      "Tunnels",
      "Local tunnels",
    ]);
  });
});

describe("zone form", () => {
  async function fillAndSubmit() {
    const name = input("name");
    const zoneId = input("zoneId");
    if (!name || !zoneId) throw new Error("zone fields missing");
    await type(name, "example.com");
    await type(zoneId, ZONE_ID);
    await act(async () => button("Add zone")?.click());
  }

  it("zone form token optional when an account exists", async () => {
    await render(<CloudflareZoneForm mode={{ type: "create" }} hasAccount />);
    // The token sits under Advanced options.
    expect(input("apiToken")).toBeNull();
    await fillAndSubmit();
    expect(api.createZone).toHaveBeenCalledWith({
      name: "example.com",
      zoneId: ZONE_ID,
    });
  });

  it("requires the token without an account", async () => {
    await render(
      <CloudflareZoneForm mode={{ type: "create" }} hasAccount={false} />
    );
    expect(input("apiToken")).not.toBeNull();
    await fillAndSubmit();
    expect(api.createZone).not.toHaveBeenCalled();
  });
});

describe("/admin/tunnels redirects", () => {
  async function target(file: string, params: Record<string, string>) {
    const { Route: Old } = await import(
      `../web/routes/$locale/_app/${file}.tsx`
    );
    const beforeLoad = Old.options.beforeLoad as (ctx: unknown) => unknown;
    try {
      beforeLoad({ params: { locale: "en", ...params } });
    } catch (error) {
      return (error as { options: { href: string } }).options.href;
    }
    throw new Error(`${file} did not redirect`);
  }

  it("sends every old path to its place under /admin/cloudflare", async () => {
    const id = "0197f3a0-1b2c-7def-8000-0123456789c1";
    expect(await target("admin.tunnels.index", {})).toBe(
      "/en/admin/cloudflare"
    );
    expect(await target("admin.tunnels.zones.index", {})).toBe(
      "/en/admin/cloudflare#zones"
    );
    expect(await target("admin.tunnels.zones.new", {})).toBe(
      "/en/admin/cloudflare/zones/new"
    );
    expect(await target("admin.tunnels.zones.$id", { id })).toBe(
      `/en/admin/cloudflare/zones/${id}`
    );
    expect(await target("admin.tunnels.new", {})).toBe(
      "/en/admin/cloudflare/local-tunnels/new"
    );
    expect(await target("admin.tunnels.$id.index", { id })).toBe(
      `/en/admin/cloudflare/local-tunnels/${id}`
    );
    expect(await target("admin.tunnels.$id.edit", { id })).toBe(
      `/en/admin/cloudflare/local-tunnels/${id}/edit`
    );
  });
});

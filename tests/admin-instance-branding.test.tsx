// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}));
const router = vi.hoisted(() => ({ invalidate: vi.fn(async () => {}) }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => router,
}));
vi.mock("@/web/api/instance", () => ({
  getBrandingQuery: () => ({
    queryKey: ["instance", "getBranding"],
    queryFn: api.get,
  }),
  saveBranding: api.save,
  uploadBrandLogo: api.upload,
  removeBrandLogo: api.remove,
}));

import { ApiError } from "@/web/api/client";
import { bootstrapQuery } from "@/web/api/session";
import { ME_QUERY_KEY } from "@/web/query-client";
import { BrandingTab } from "../web/routes/$locale/_app/-components/admin/instance/branding-tab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.instance.branding;
const LIGHT = { type: "image/svg+xml", src: "/brand/logo?v=k1" };
const DARK = { type: "image/svg+xml", src: "/brand/logo?theme=dark&v=k1" };

type Settings = {
  name: string | null;
  company: string | null;
  accent: string | null;
  logo: typeof LIGHT | null;
  logoDark: typeof DARK | null;
};

function settings(extra: Partial<Settings> = {}): Settings {
  return {
    name: null,
    company: null,
    accent: null,
    logo: null,
    logoDark: null,
    ...extra,
  };
}

const BOOTSTRAP = {
  appName: "Menara",
  companyName: null,
  accent: "neutral",
  logo: null,
  icon: { src: "/brand/icon.svg", type: "image/svg+xml", custom: false },
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

async function render(stored: Settings) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  api.get.mockResolvedValue(stored);
  queryClient.setQueryData(["instance", "getBranding"], stored);
  queryClient.setQueryData(bootstrapQuery().queryKey, BOOTSTRAP as never);
  queryClient.setQueryData(ME_QUERY_KEY, {
    user: { id: "u1", accentColor: null },
    orgRole: "admin",
    timeZone: "UTC",
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <BrandingTab />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  delete document.documentElement.dataset.accent;
});

const byId = (id: string) =>
  container.querySelector<HTMLInputElement>(`#${id}`);
const preview = () =>
  container.querySelector<HTMLElement>("[data-slot='brand-preview']");

async function type(field: HTMLInputElement | null, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: Element | null | undefined) {
  await act(async () => {
    (element as HTMLElement | null)?.click();
  });
}

async function pick(theme: "light" | "dark", file: File) {
  const input = byId(`brand-logo-${theme}`);
  await act(async () => {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const logoField = (theme: "light" | "dark") =>
  container.querySelector<HTMLElement>(`[data-logo-theme='${theme}']`);
const buttonIn = (scope: Element | null, label: string) =>
  [...(scope?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.trim() === label
  );

describe("Admin → Instance → Branding", () => {
  it("shows the stored values and the restart hint under the name", async () => {
    await render(
      settings({ name: "Acme Ops", company: "ACME Corp", accent: "blue" })
    );
    const name = byId("brand-name");
    expect(name?.value).toBe("Acme Ops");
    expect(name?.placeholder).toBe("Menara");
    expect(byId("brand-company")?.value).toBe("ACME Corp");
    // The hint sits in the name's field.
    expect(name?.closest("[data-slot='field']")?.textContent).toContain(
      t.nameRestartHint
    );
    // The radio's labelled input (Base UI keeps a hidden one per radio).
    expect(byId("brand-accent-blue")?.checked).toBe(true);
    expect(byId("brand-accent-default")?.checked).toBe(false);
    expect(preview()?.getAttribute("data-accent")).toBe("blue");
    // No light logo yet: the dark one cannot be picked.
    expect(byId("brand-logo-light")?.disabled).toBe(false);
    expect(byId("brand-logo-dark")?.disabled).toBe(true);
    expect(logoField("dark")?.textContent).toContain(t.logoDarkNeedsLight);
  });

  it("the preview follows unsaved edits", async () => {
    await render(settings({ logo: LIGHT }));
    // Stored logos show in the preview at once.
    expect(preview()?.querySelector(`img[src='${LIGHT.src}']`)).not.toBeNull();
    await type(byId("brand-name"), "Acme Ops");
    const headers = preview()?.querySelectorAll(
      "[data-slot='brand-preview-header']"
    );
    expect(headers).toHaveLength(2);
    for (const header of headers ?? []) {
      expect(header.textContent).toContain("Acme Ops");
    }
    await click(byId("brand-accent-green"));
    expect(preview()?.getAttribute("data-accent")).toBe("green");
    // Unsaved: nothing was sent.
    expect(api.save).not.toHaveBeenCalled();
  });

  it("saves name, company and accent, then refreshes bootstrap and the router", async () => {
    api.save.mockResolvedValue(settings({ name: "Acme Ops", accent: "green" }));
    await render(settings());
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await type(byId("brand-name"), "Acme Ops");
    await click(byId("brand-accent-green"));
    await act(async () => {
      byId("brand-name")?.form?.requestSubmit();
    });
    await vi.waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        name: "Acme Ops",
        company: null,
        accent: "green",
      })
    );
    await vi.waitFor(() => expect(router.invalidate).toHaveBeenCalled());
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["session", "getBootstrap"],
    });
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["instance", "getBranding"] })
    );
    // The admin has no own accent: the page wears the new instance accent.
    expect(document.documentElement.dataset.accent).toBe("green");
  });

  it("saves the default accent as null", async () => {
    api.save.mockResolvedValue(settings());
    await render(settings({ accent: "rose" }));
    await click(byId("brand-accent-default"));
    expect(preview()?.getAttribute("data-accent")).toBe("neutral");
    await act(async () => {
      byId("brand-name")?.form?.requestSubmit();
    });
    await vi.waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        name: null,
        company: null,
        accent: null,
      })
    );
  });

  it("uploads a picked logo at once and shows a server error code as text", async () => {
    api.upload.mockResolvedValueOnce(settings({ logo: LIGHT }));
    await render(settings());
    const file = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
    await pick("light", file);
    await vi.waitFor(() =>
      expect(api.upload).toHaveBeenCalledWith("light", file)
    );
    await vi.waitFor(() => expect(router.invalidate).toHaveBeenCalled());

    api.upload.mockRejectedValueOnce(new ApiError(422, "not_square"));
    await pick("light", file);
    await vi.waitFor(() =>
      expect(logoField("light")?.textContent).toContain(t.error.not_square)
    );
    // An upload never submits the text fields.
    expect(api.save).not.toHaveBeenCalled();
  });

  it("removes the dark logo", async () => {
    api.remove.mockResolvedValue(settings({ logo: LIGHT }));
    await render(settings({ logo: LIGHT, logoDark: DARK }));
    expect(byId("brand-logo-dark")?.disabled).toBe(false);
    await click(buttonIn(logoField("dark"), t.remove));
    await vi.waitFor(() => expect(api.remove).toHaveBeenCalledWith("dark"));
    await vi.waitFor(() => expect(router.invalidate).toHaveBeenCalled());
  });
});

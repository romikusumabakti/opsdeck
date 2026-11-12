// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const api = vi.hoisted(() => ({
  moveToKey: vi.fn(),
  reinstall: vi.fn(),
  trust: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  test: vi.fn(),
  remove: vi.fn(),
  bulkRemove: vi.fn(),
  sshKey: vi.fn(),
  line: vi.fn(),
  push: vi.fn(),
  confirm: vi.fn(),
  confirmTyping: vi.fn(),
  serverLine: vi.fn(),
  check: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: api.push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/servers",
  useSearchParams: () => new URLSearchParams(),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/dialog-provider", () => ({
  useDialog: () => ({ confirm: api.confirm, confirmTyping: api.confirmTyping }),
}));
vi.mock("@/web/api/servers", () => ({
  moveServerToKey: api.moveToKey,
  reinstallServerKey: api.reinstall,
  trustServerHostKey: api.trust,
  createServer: api.create,
  updateServer: api.update,
  testServerConnection: api.test,
  deleteServer: api.remove,
  bulkDeleteServers: api.bulkRemove,
  checkServerKeyLogin: api.check,
  getServerAuthorizedLineQuery: (id: string, from: string) => ({
    queryKey: ["servers", "getServerAuthorizedLine", id, from],
    queryFn: () => api.serverLine(id, from),
    retry: false,
  }),
}));
vi.mock("@/web/api/instance", () => ({
  getInstanceSshKeyQuery: () => ({
    queryKey: ["instance", "getInstanceSshKey"],
    queryFn: api.sshKey,
  }),
  getAuthorizedKeysLineQuery: (from: string) => ({
    queryKey: ["instance", "getAuthorizedKeysLine", from],
    queryFn: () => api.line(from),
    retry: false,
  }),
}));

import { ServerForm } from "../components/server-form";
import { ServerAccessCard } from "../web/routes/$locale/_app/-components/servers/server-access-card";
import { ServersClient } from "../web/routes/$locale/_app/-components/servers/servers-client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ID = "0197f3a0-1b2c-7def-8000-000000000001";
const KEY_ID = "0197f3a0-1b2c-7def-8000-0000000000cc";
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPanelKey";
const t = messages.serverAccess;
const tForm = messages.serverForm;
const tServers = messages.servers;

function server(extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: "web-1",
    host: "192.0.2.10",
    username: "root",
    auth: "key" as "key" | "password",
    hasPassword: false,
    hostKeyFingerprint: "SHA256:pinnedFp" as string | null,
    hostKeyPinnedAt: "2026-11-09T10:00:00.000Z" as string | null,
    hostKeyMismatch: false,
    offeredFingerprint: null as string | null,
    sshKeyId: KEY_ID as string | null,
    keyMarker: `opsdeck:opsdeck:${KEY_ID}` as string | null,
    sshFrom: "172.29.0.0/16" as string | null,
    keyError: null as string | null,
    sftpRoot: "/",
    placement: "restricted" as const,
    infraOnly: false,
    preflight: null,
    preflightAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-09T10:00:00.000Z",
    ...extra,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

async function render(node: React.ReactNode) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["instance", "getInstanceSshKey"], {
    publicKey: PUBLIC_KEY,
    fingerprint: "SHA256:instanceFp",
    lastJob: null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Suspense fallback="loading">{node}</Suspense>
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

beforeEach(() => {
  api.sshKey.mockResolvedValue({
    publicKey: PUBLIC_KEY,
    fingerprint: "SHA256:instanceFp",
    lastJob: null,
  });
  api.serverLine.mockImplementation(async (_id: string, from: string) => ({
    line: `from="${from}" row-key`,
    command: `install from="${from}" row-key`,
  }));
  api.line.mockImplementation(async (from: string) => ({
    line: `from="${from}",no-agent-forwarding,no-X11-forwarding ${PUBLIC_KEY} opsdeck:opsdeck:${KEY_ID}`,
    command: `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '\\n%s\\n' 'from="${from}" …' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
  }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const text = () => document.body.textContent ?? "";
const buttons = () => [...document.querySelectorAll("button")];
const button = (label: string) =>
  buttons().find((b) => b.textContent?.trim() === label);
const input = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[name='${name}']`);

/** Types into a controlled input the way React sees it. */
async function type(el: HTMLInputElement | null, value: string) {
  if (!el) throw new Error("no input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
  });
}

const ALL = { manage: true, terminal: () => true, files: () => true };
const NONE = { manage: false, terminal: () => false, files: () => false };

describe("servers list", () => {
  it("has an Access column with Key, Password, or a host-key warning", async () => {
    await render(
      <ServersClient
        can={ALL}
        servers={[
          server({ id: `${ID.slice(0, -1)}1`, name: "a-key" }),
          server({
            id: `${ID.slice(0, -1)}2`,
            name: "b-password",
            auth: "password",
            hasPassword: true,
            keyMarker: null,
            sshKeyId: null,
          }),
          server({
            id: `${ID.slice(0, -1)}3`,
            name: "c-changed",
            hostKeyMismatch: true,
            offeredFingerprint: "SHA256:offeredFp",
          }),
        ]}
      />
    );
    const headers = [...document.querySelectorAll("th")].map(
      (th) => th.textContent
    );
    expect(headers).toContain(tServers.colAccess);
    const rows = [...document.querySelectorAll("tbody tr")].map(
      (tr) => tr.textContent ?? ""
    );
    expect(rows[0]).toContain(tServers.accessKey);
    expect(rows[1]).toContain(tServers.accessPassword);
    expect(rows[2]).toContain(tServers.accessHostKeyChanged);
  });

  it("deleting a key server says its key line stays on the server", async () => {
    api.confirmTyping.mockResolvedValue(false);
    await render(<ServersClient can={ALL} servers={[server()]} />);
    const menu = document.querySelector<HTMLElement>(
      `button[aria-label='${messages.common.openMenu}']`
    );
    await click(menu);
    const remove = [...document.querySelectorAll("[role='menuitem']")].find(
      (el) => el.textContent?.includes(messages.common.delete)
    );
    await click(remove);
    const options = api.confirmTyping.mock.calls[0]?.[0];
    const shown = document.createElement("div");
    const shownRoot = createRoot(shown);
    await act(async () => shownRoot.render(options.description));
    expect(shown.textContent).toContain(`opsdeck:opsdeck:${KEY_ID}`);
    expect(shown.textContent).toContain("authorized_keys");
    act(() => shownRoot.unmount());
  });

  it("hides Terminal and Files on an infra-only server the grant cannot reach", async () => {
    const normal = `${ID.slice(0, -1)}1`;
    const infra = `${ID.slice(0, -1)}2`;
    // An engineer member: the grant applies to normal servers only.
    const engineer = {
      manage: false,
      terminal: (infraOnly: boolean) => !infraOnly,
      files: (infraOnly: boolean) => !infraOnly,
    };
    await render(
      <ServersClient
        can={engineer}
        servers={[
          server({ id: normal, name: "a-normal" }),
          server({ id: infra, name: "b-panel", infraOnly: true }),
        ]}
      />
    );
    const rows = [...document.querySelectorAll("tbody tr")];
    expect(rows[1]?.textContent).toContain(tServers.infraOnly);
    expect(rows[0]?.textContent).not.toContain(tServers.infraOnly);
    expect(
      document.querySelector(`a[href='/servers/${normal}/files']`)
    ).not.toBeNull();
    expect(
      document.querySelector(`a[href='/servers/${infra}/files']`)
    ).toBeNull();

    const menus = document.querySelectorAll<HTMLElement>(
      `button[aria-label='${messages.common.openMenu}']`
    );
    // The infra-only row's menu (the table renders each row's menu first).
    await click(menus[1]);
    const menu = document.querySelector("[role='menu']")?.textContent ?? "";
    expect(menu).toContain(messages.common.view);
    expect(menu).not.toContain(tServers.openTerminal);
  });

  it("observers see no delete", async () => {
    await render(<ServersClient can={NONE} servers={[server()]} />);
    expect(text()).not.toContain(messages.common.delete);
    expect(document.querySelector("input[type='checkbox']")).toBeNull();
  });
});

describe("server page access card", () => {
  it("shows the fingerprint, pin date and from, with Reinstall key for a key server", async () => {
    await render(<ServerAccessCard server={server()} canManage />);
    expect(text()).toContain("SHA256:pinnedFp");
    expect(text()).toContain("172.29.0.0/16");
    expect(text()).toContain("2026");
    expect(button(t.reinstallKey)).toBeDefined();
    expect(button(t.moveToKey)).toBeUndefined();
  });

  it("Move to SSH key moves a password server with its stored password", async () => {
    api.moveToKey.mockResolvedValue({ ok: true });
    await render(
      <ServerAccessCard
        server={server({ auth: "password", hasPassword: true, sshFrom: null })}
        canManage
      />
    );
    expect(button(t.reinstallKey)).toBeUndefined();
    await click(button(t.moveToKey));
    expect(api.moveToKey).toHaveBeenCalledWith(ID);
  });

  it("Reinstall key asks for the password once and sends it", async () => {
    api.reinstall.mockResolvedValue({ ok: true });
    await render(<ServerAccessCard server={server()} canManage />);
    await click(button(t.reinstallKey));
    const password = document.querySelector<HTMLInputElement>(
      "input[type='password']"
    );
    await type(password, "s3cret");
    await click(button(t.install));
    expect(api.reinstall).toHaveBeenCalledWith(ID, "s3cret");
  });

  it("a mismatch banner shows both fingerprints and trusts the displayed one", async () => {
    api.trust.mockResolvedValue({ ok: true });
    api.confirm.mockResolvedValue(true);
    await render(
      <ServerAccessCard
        server={server({
          hostKeyMismatch: true,
          offeredFingerprint: "SHA256:offeredFp",
        })}
        canManage
      />
    );
    const banner = document.querySelector("[role='alert']");
    expect(banner?.textContent).toContain(t.mismatchTitle);
    expect(banner?.textContent).toContain("SHA256:pinnedFp");
    expect(banner?.textContent).toContain("SHA256:offeredFp");
    await click(button(t.trustNewKey));
    expect(api.trust).toHaveBeenCalledWith(ID, "SHA256:offeredFp");
  });

  it("without server:manage there is no action, not even Trust new key", async () => {
    await render(
      <ServerAccessCard
        server={server({
          hostKeyMismatch: true,
          offeredFingerprint: "SHA256:offeredFp",
        })}
        canManage={false}
      />
    );
    expect(text()).toContain("SHA256:offeredFp");
    expect(button(t.trustNewKey)).toBeUndefined();
    expect(button(t.reinstallKey)).toBeUndefined();
    expect(button(t.moveToKey)).toBeUndefined();
  });
});

describe("server form", () => {
  it("edit: the password is only under Advanced options while auth=password", async () => {
    await render(
      <ServerForm
        mode={{
          type: "edit",
          server: server({ auth: "password", hasPassword: true }),
        }}
      />
    );
    expect(input("password")).toBeNull();
    await click(button(messages.setup.advancedOptions));
    expect(input("password")).not.toBeNull();
  });

  it("edit: a key server has no password field at all", async () => {
    await render(<ServerForm mode={{ type: "edit", server: server() }} />);
    const advanced = button(messages.setup.advancedOptions);
    if (advanced) await click(advanced);
    expect(input("password")).toBeNull();
  });

  it("new: defaults to installing the key yourself, with the public key and a command for the typed from", async () => {
    api.create.mockResolvedValue({
      success: true,
      data: server(),
      message: "ok",
    });
    await render(<ServerForm mode={{ type: "create" }} />);
    expect(text()).toContain(tForm.methodKey);
    expect(text()).toContain(PUBLIC_KEY);
    expect(input("password")).toBeNull();
    await type(input("name"), "web-2");
    await type(input("host"), "192.0.2.11");
    await type(input("username"), "root");
    await type(input("sshFrom"), "192.0.2.1");
    await vi.waitFor(() => expect(text()).toContain('from="192.0.2.1"'));
    expect(api.line).toHaveBeenCalledWith("192.0.2.1");
    await act(async () => {
      document
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
    });
    await vi.waitFor(() => expect(api.create).toHaveBeenCalled());
    const sent = api.create.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ auth: "key", sshFrom: "192.0.2.1" });
    expect(sent).not.toHaveProperty("password");
  });

  it("new: the root password once creates without a password, then installs the key with it", async () => {
    api.create.mockResolvedValue({
      success: true,
      data: server({ auth: "password", hasPassword: false }),
      message: "ok",
    });
    api.reinstall.mockResolvedValue({ ok: true });
    await render(<ServerForm mode={{ type: "create" }} />);
    const radio = [...document.querySelectorAll("label")].find((l) =>
      l.textContent?.includes(tForm.methodPassword)
    );
    await click(radio);
    expect(input("sshFrom")).toBeNull();
    await type(input("name"), "web-2");
    await type(input("host"), "192.0.2.11");
    await type(input("username"), "root");
    await type(input("password"), "s3cret");
    await act(async () => {
      document
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
    });
    await vi.waitFor(() => expect(api.reinstall).toHaveBeenCalled());
    const sent = api.create.mock.calls[0]?.[0];
    expect(sent).not.toHaveProperty("password");
    expect(sent).not.toHaveProperty("auth", "key");
    expect(JSON.stringify(sent)).not.toContain("s3cret");
    expect(api.reinstall).toHaveBeenCalledWith(ID, "s3cret");
  });
});

const submit = () =>
  act(async () => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

describe("servers that cannot sign in yet", () => {
  it("the list shows Key not verified yet and Needs setup", async () => {
    await render(
      <ServersClient
        can={ALL}
        servers={[
          server({
            id: `${ID.slice(0, -1)}1`,
            name: "a",
            keyError: "keyNotVerified",
          }),
          server({
            id: `${ID.slice(0, -1)}2`,
            name: "b",
            auth: "password",
            hasPassword: false,
            keyMarker: null,
            sshKeyId: null,
          }),
        ]}
      />
    );
    const rows = [...document.querySelectorAll("tbody tr")].map(
      (tr) => tr.textContent ?? ""
    );
    expect(rows[0]).toContain(tServers.accessKeyNotVerified);
    expect(rows[1]).toContain(tServers.accessNeedsSetup);
    expect(rows[1]).not.toContain(tServers.accessPassword);
  });

  it("an unverified key server's page shows its own command for an edited from, and checks the key", async () => {
    api.check.mockResolvedValue({ ok: true });
    await render(
      <ServerAccessCard
        server={server({ keyError: "keyNotVerified", sshFrom: "192.0.2.1" })}
        canManage
      />
    );
    expect(text()).toContain(t.keyNotVerified);
    // Open at once, for the saved row's from.
    expect(input("sshFrom")?.value).toBe("192.0.2.1");
    await vi.waitFor(() =>
      expect(text()).toContain('install from="192.0.2.1" row-key')
    );
    expect(api.serverLine).toHaveBeenCalledWith(ID, "192.0.2.1");

    await type(input("sshFrom"), "192.0.2.5");
    // The old from's command is not shown for the new address.
    expect(text()).not.toContain('install from="192.0.2.1" row-key');
    await vi.waitFor(() =>
      expect(text()).toContain('install from="192.0.2.5" row-key')
    );
    // The host's line decides the saved from=, not this field.
    await click(button(t.checkKeyLogin));
    expect(api.check).toHaveBeenCalledWith(ID);
  });

  it("Needs setup: Move to SSH key asks for the password and installs with it", async () => {
    api.reinstall.mockResolvedValue({ ok: true });
    await render(
      <ServerAccessCard
        server={server({ auth: "password", hasPassword: false, sshFrom: null })}
        canManage
      />
    );
    expect(text()).toContain(t.needsSetup);
    await click(button(t.moveToKey));
    expect(api.moveToKey).not.toHaveBeenCalled();
    await type(
      document.querySelector<HTMLInputElement>("input[type='password']"),
      "s3cret"
    );
    await click(button(t.install));
    expect(api.reinstall).toHaveBeenCalledWith(ID, "s3cret");
  });

  it("a refused key action shows the server's message", async () => {
    const { ApiError } = await import("@/web/api/client");
    api.moveToKey.mockRejectedValue(
      new ApiError(
        409,
        "Another SSH key operation is running.",
        "keyJobRunning"
      )
    );
    await render(
      <ServerAccessCard
        server={server({ auth: "password", hasPassword: true })}
        canManage
      />
    );
    await click(button(t.moveToKey));
    expect(toast.error).toHaveBeenCalledWith(
      "Another SSH key operation is running."
    );
  });
});

describe("new server, after it is created", () => {
  async function fill() {
    await type(input("name"), "web-2");
    await type(input("host"), "192.0.2.11");
    await type(input("username"), "root");
  }

  it("key mode goes to the server page (the saved row's command)", async () => {
    api.create.mockResolvedValue({
      success: true,
      data: server(),
      message: "ok",
    });
    await render(<ServerForm mode={{ type: "create" }} />);
    await fill();
    await type(input("sshFrom"), "192.0.2.1");
    await submit();
    await vi.waitFor(() =>
      expect(api.push).toHaveBeenCalledWith(`/servers/${ID}`)
    );
  });

  it("the command waits for the typing to stop and is only for the typed from", async () => {
    await render(<ServerForm mode={{ type: "create" }} />);
    await type(input("sshFrom"), "1");
    await type(input("sshFrom"), "19");
    await type(input("sshFrom"), "192.0.2.1");
    await vi.waitFor(() => expect(text()).toContain('from="192.0.2.1"'));
    expect(api.line.mock.calls).toEqual([["192.0.2.1"]]);
  });

  it("password once: a failed install never creates again and opens the new server", async () => {
    api.create.mockResolvedValue({
      success: true,
      data: server({ auth: "password", hasPassword: false }),
      message: "ok",
    });
    api.reinstall.mockRejectedValue(new TypeError("Failed to fetch"));
    await render(<ServerForm mode={{ type: "create" }} />);
    const radio = [...document.querySelectorAll("label")].find((l) =>
      l.textContent?.includes(tForm.methodPassword)
    );
    await click(radio);
    await fill();
    await type(input("password"), "s3cret");
    await submit();
    await vi.waitFor(() =>
      expect(api.push).toHaveBeenCalledWith(`/servers/${ID}`)
    );
    expect(toast.error).toHaveBeenCalled();
    expect(api.create).toHaveBeenCalledTimes(1);
  });
});

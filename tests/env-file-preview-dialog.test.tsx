// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../messages/en.json";

// The managed .env switch in Source & Deploy: turning it on previews the
// .env the next deploy would write and asks for a confirm when anything
// changes or a dir could not be compared; turning it off stays immediate;
// "Preview .env" opens the same preview read-only, also from Variables.

const ENV = "0197f3a0-1b2c-7def-8000-0123456789e1";

const api = vi.hoisted(() => ({
  previewEnvFile: vi.fn(),
  setEnvFileManaged: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ orgRole: "engineer" }),
}));
vi.mock("@/web/api/variables", () => ({
  previewEnvFile: api.previewEnvFile,
  setEnvFileManaged: api.setEnvFileManaged,
  previewTextImport: vi.fn(),
  readServerImport: vi.fn(),
  saveImport: vi.fn(),
  applyVariableTemplate: vi.fn(),
  deleteVariable: vi.fn(),
  regenerateVariable: vi.fn(),
  revealVariables: vi.fn(),
  putVariable: vi.fn(),
}));

import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import { applyBranding } from "@/i18n/branding";
import type { ProjectRole } from "@/lib/permissions";
import { ApiError } from "@/web/api/client";
import type { EnvFilePreview } from "@/web/api/variables";
import { EnvFileManagedSwitch } from "../web/routes/$locale/_app/-components/env/settings/env-file-managed-switch";
import { VariablesClient } from "../web/routes/$locale/_app/-components/env/variables/variables-client";

const messages = applyBranding(enMessages, {
  appName: "Menara",
  companyName: null,
  allowedEmailDomain: "example.com",
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.variables.envPreview;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(node: React.ReactNode, role: ProjectRole = "engineer") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <DialogProvider>
            <ProjectRoleProvider role={role}>{node}</ProjectRoleProvider>
          </DialogProvider>
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const body = () => document.body.textContent ?? "";
const button = (text: string) =>
  [...document.querySelectorAll("button")].findLast(
    (b) => b.textContent?.trim() === text
  );
const dialog = () => document.querySelector('[role="dialog"]');
const managedSwitch = () =>
  document.querySelector<HTMLElement>('[role="switch"]');
const confirmBox = () =>
  document.querySelector<HTMLElement>("#env-preview-confirm");
// The table row of a key, by its name cell.
const rowOf = (name: string) =>
  [...document.querySelectorAll("tr")].find(
    (tr) => tr.querySelector("code")?.textContent === name
  );

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement | null | undefined)?.click());
  for (let i = 0; i < 6; i++) await flush();
}

type Dir = EnvFilePreview["dirs"][number];

function dir(partial: Partial<Dir> = {}): Dir {
  return {
    serverName: "kestrel-app",
    deployDir: "/srv/kestrel",
    status: "compared",
    changes: [],
    unchangedCount: 4,
    ...partial,
  };
}

const CHANGES: Dir["changes"] = [
  {
    name: "APP_VERSION",
    status: "added",
    masked: false,
    panelWritten: true,
    reserved: false,
  },
  {
    name: "COMPOSE_PROJECT_NAME",
    status: "removed",
    masked: false,
    panelWritten: false,
    reserved: true,
    before: "kestrel-old",
  },
  {
    name: "DB_PASSWORD",
    status: "changed",
    masked: true,
    panelWritten: false,
    reserved: false,
  },
  {
    name: "LOG_LEVEL",
    status: "changed",
    masked: false,
    panelWritten: false,
    reserved: false,
    before: "debug",
    after: "info",
  },
];

const environment = (envFileManaged: boolean) => ({ id: ENV, envFileManaged });

async function turnOn(preview: EnvFilePreview | Error) {
  if (preview instanceof Error) api.previewEnvFile.mockRejectedValue(preview);
  else api.previewEnvFile.mockResolvedValue(preview);
  api.setEnvFileManaged.mockResolvedValue({ envFileManaged: true });
  await render(<EnvFileManagedSwitch environment={environment(false)} />);
  await click(managedSwitch());
}

describe("managed .env switch: turning on", () => {
  it("enables at once when nothing changes and every dir was compared", async () => {
    await turnOn({ dirs: [dir()] });
    expect(api.previewEnvFile).toHaveBeenCalledWith(ENV);
    expect(api.setEnvFileManaged).toHaveBeenCalledWith(ENV, true, 0);
    expect(confirmBox()).toBeNull();
    expect(api.toast.success).toHaveBeenCalledWith(
      messages.variables.managedOn
    );
    expect(dialog()).toBeNull();
  });

  it("lists the diff with reserved keys in red and masked values, and needs the confirm", async () => {
    await turnOn({ dirs: [dir({ changes: CHANGES })] });
    expect(api.setEnvFileManaged).not.toHaveBeenCalled();
    expect(body()).toContain("4 keys change on the next deploy");

    // Reserved: the live COMPOSE_PROJECT_NAME the managed file drops.
    const reserved = rowOf("COMPOSE_PROJECT_NAME");
    expect(reserved?.className).toContain("text-destructive");
    expect(reserved?.textContent).toContain(t.reserved);
    expect(reserved?.textContent).toContain("kestrel-old");

    // Masked: six dots, no value, no length.
    const secret = rowOf("DB_PASSWORD");
    expect(secret?.textContent).toMatch(/(^|[^•])••••••([^•]|$)/);
    expect(secret?.className).not.toContain("text-destructive");

    // A tag the Panel writes at the next deploy.
    expect(rowOf("APP_VERSION")?.textContent).toContain(t.setAtDeploy);
    expect(rowOf("LOG_LEVEL")?.textContent).toContain("debug");
    expect(rowOf("LOG_LEVEL")?.textContent).toContain("info");
    expect(body()).toContain("4 unchanged");

    const enable = button(t.enable);
    expect(enable?.disabled).toBe(true);
    await click(confirmBox());
    expect(enable?.disabled).toBe(false);
    await click(enable);
    expect(api.setEnvFileManaged).toHaveBeenCalledWith(ENV, true, 4);
    expect(dialog()).toBeNull();
  });

  it("counts the changes of every dir it acknowledges", async () => {
    await turnOn({
      dirs: [
        dir({ changes: CHANGES.slice(0, 2) }),
        dir({ deployDir: "/srv/kestrel-web", changes: CHANGES.slice(3) }),
      ],
    });
    await click(confirmBox());
    await click(button(t.enable));
    expect(api.setEnvFileManaged).toHaveBeenCalledWith(ENV, true, 3);
  });

  it("asks for the confirm when a dir was not compared, even without changes", async () => {
    await turnOn({
      dirs: [
        dir(),
        dir({
          deployDir: "/srv/kestrel-web",
          status: "notCompared",
          unchangedCount: 0,
        }),
      ],
    });
    expect(api.setEnvFileManaged).not.toHaveBeenCalled();
    expect(body()).toContain(t.notComparedWarning);
    expect(body()).toContain("kestrel-app:/srv/kestrel-web");
    expect(button(t.enable)?.disabled).toBe(true);
    await click(confirmBox());
    await click(button(t.enable));
    expect(api.setEnvFileManaged).toHaveBeenCalledWith(ENV, true, 0);
  });

  it("enables nothing when the dialog is closed while the preview is pending", async () => {
    let resolve: (preview: EnvFilePreview) => void = () => {};
    api.previewEnvFile.mockReturnValue(
      new Promise<EnvFilePreview>((r) => {
        resolve = r;
      })
    );
    api.setEnvFileManaged.mockResolvedValue({ envFileManaged: true });
    await render(<EnvFileManagedSwitch environment={environment(false)} />);
    await click(managedSwitch());
    expect(body()).toContain(t.loading);
    await click(button(messages.common.cancel));
    await act(async () => resolve({ dirs: [dir()] }));
    for (let i = 0; i < 6; i++) await flush();
    expect(api.setEnvFileManaged).not.toHaveBeenCalled();
    expect(api.toast.success).not.toHaveBeenCalled();
  });

  it("waits for the Enable click when there is no deploy dir", async () => {
    await turnOn({ dirs: [] });
    expect(body()).toContain(t.noDirs);
    expect(api.setEnvFileManaged).not.toHaveBeenCalled();
    expect(confirmBox()).toBeNull();
    await click(button(t.enable));
    expect(api.setEnvFileManaged).toHaveBeenCalledWith(ENV, true, 0);
  });

  it("refuses a dir another environment deploys into", async () => {
    await turnOn({ dirs: [dir({ sharedDir: true, changes: CHANGES })] });
    expect(body()).toContain(messages.variables.sharedDeployDir);
    expect(confirmBox()).toBeNull();
    expect(button(t.enable)?.disabled).toBe(true);
    expect(api.setEnvFileManaged).not.toHaveBeenCalled();
  });

  it("shows the strong sign-in refusal and keeps the switch off", async () => {
    await turnOn(
      new ApiError(
        403,
        messages.strongSignIn.refusal,
        "strong_sign_in_required"
      )
    );
    expect(body()).toContain(messages.strongSignIn.refusal);
    expect(body()).toContain(t.stillOff);
    expect(button(t.enable)).toBeUndefined();
    expect(api.setEnvFileManaged).not.toHaveBeenCalled();
  });

  it("does not enable blind when deploying is disabled or the variables are invalid", async () => {
    await turnOn(new ApiError(503, "Deploy disabled", "deployDisabled"));
    expect(body()).toContain(messages.deploys.deployDisabled);
    expect(button(t.enable)).toBeUndefined();
    act(() => root.unmount());
    document.body.innerHTML = "";

    await turnOn(new ApiError(409, "invalid", "envFileInvalid"));
    expect(body()).toContain(messages.variables.import.errors.envFileInvalid);
    expect(api.setEnvFileManaged).not.toHaveBeenCalled();
  });

  it("shows a refusal of the switch itself in the dialog", async () => {
    api.previewEnvFile.mockResolvedValue({ dirs: [dir({ changes: CHANGES })] });
    api.setEnvFileManaged.mockRejectedValue(
      new ApiError(409, "Missing required variables: API_KEY")
    );
    await render(<EnvFileManagedSwitch environment={environment(false)} />);
    await click(managedSwitch());
    await click(confirmBox());
    await click(button(t.enable));
    expect(body()).toContain("Add the required variables first: API_KEY");
    expect(dialog()).not.toBeNull();
  });
});

describe("managed .env switch: off and read-only preview", () => {
  it("turns off at once without a preview", async () => {
    api.setEnvFileManaged.mockResolvedValue({ envFileManaged: false });
    await render(<EnvFileManagedSwitch environment={environment(true)} />);
    await click(managedSwitch());
    expect(api.previewEnvFile).not.toHaveBeenCalled();
    expect(api.setEnvFileManaged).toHaveBeenCalledWith(ENV, false);
  });

  it("opens the preview read-only from the link", async () => {
    api.previewEnvFile.mockResolvedValue({ dirs: [dir({ changes: CHANGES })] });
    await render(<EnvFileManagedSwitch environment={environment(true)} />);
    await click(button(t.link));
    expect(dialog()).not.toBeNull();
    expect(rowOf("LOG_LEVEL")).toBeTruthy();
    expect(confirmBox()).toBeNull();
    expect(button(t.enable)).toBeUndefined();
    expect(api.setEnvFileManaged).not.toHaveBeenCalled();
  });

  it("says when the next deploy writes the same .env", async () => {
    api.previewEnvFile.mockResolvedValue({ dirs: [dir()] });
    await render(<EnvFileManagedSwitch environment={environment(false)} />);
    await click(button(t.link));
    expect(body()).toContain(t.noChanges);
    expect(api.setEnvFileManaged).not.toHaveBeenCalled();
  });

  it("hides the switch and the link without the rights", async () => {
    await render(
      <EnvFileManagedSwitch environment={environment(false)} />,
      "qa"
    );
    expect(button(t.link)).toBeUndefined();
    expect(managedSwitch()?.hasAttribute("data-disabled")).toBe(true);
  });
});

describe("Variables tab: unmanaged hint", () => {
  const listing = (envFileManaged: boolean) => ({
    envFileManaged,
    hasServices: true,
    variables: [],
  });

  it("links an unmanaged environment to the read-only preview", async () => {
    api.previewEnvFile.mockResolvedValue({ dirs: [dir({ changes: CHANGES })] });
    await render(
      <VariablesClient environmentId={ENV} listing={listing(false)} />
    );
    expect(body()).toContain(t.unmanagedHint);
    await click(button(t.link));
    expect(api.previewEnvFile).toHaveBeenCalledWith(ENV);
    expect(rowOf("LOG_LEVEL")).toBeTruthy();
    expect(button(t.enable)).toBeUndefined();
  });

  it("shows no hint to who cannot open the preview", async () => {
    await render(
      <VariablesClient environmentId={ENV} listing={listing(false)} />,
      "qa"
    );
    expect(body()).not.toContain(t.unmanagedHint);
  });

  it("shows no hint once the Panel manages the .env", async () => {
    await render(
      <VariablesClient environmentId={ENV} listing={listing(true)} />
    );
    expect(body()).not.toContain(t.unmanagedHint);
  });
});

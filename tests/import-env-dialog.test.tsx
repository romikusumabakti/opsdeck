// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import type { ImportRow } from "@/lib/variables/import-rows";
import enMessages from "../messages/en.json";

// "Import .env" in Environment settings → Variables: the Paste, Upload and
// From server sources, the review table and its default selection, the save,
// and the add-variable form's name-field paste that opens the dialog.

const ENV = "0197f3a0-1b2c-7def-8000-0123456789e1";

const api = vi.hoisted(() => ({
  previewTextImport: vi.fn(),
  readServerImport: vi.fn(),
  saveImport: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ orgRole: "engineer" }),
}));
vi.mock("@/web/api/variables", () => ({
  previewTextImport: api.previewTextImport,
  readServerImport: api.readServerImport,
  saveImport: api.saveImport,
  applyVariableTemplate: vi.fn(),
  deleteVariable: vi.fn(),
  regenerateVariable: vi.fn(),
  revealVariables: vi.fn(),
  putVariable: vi.fn(),
}));

import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import type { ProjectRole } from "@/lib/permissions";
import { ApiError } from "@/web/api/client";
import { ImportEnvDialog } from "../web/routes/$locale/_app/-components/env/variables/import-env-dialog";
import { VariablesClient } from "../web/routes/$locale/_app/-components/env/variables/variables-client";

const messages = applyBranding(enMessages, {
  appName: "Menara",
  companyName: null,
  allowedEmailDomain: "example.com",
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.variables.import;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

async function render(node: React.ReactNode, role: ProjectRole = "engineer") {
  queryClient = new QueryClient({
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
// The variable names on screen (the pasted text in the textarea aside).
const names = () =>
  [...document.querySelectorAll("code")].map((c) => c.textContent);
const tab = (text: string) =>
  [...document.querySelectorAll('[role="tab"]')].find(
    (b) => b.textContent?.trim() === text
  ) as HTMLElement | undefined;
const checkbox = (name: string) =>
  document.querySelector<HTMLElement>(
    `[role="checkbox"][aria-label="Import ${name}"]`
  );
const checked = (name: string) =>
  checkbox(name)?.getAttribute("aria-checked") === "true";
const textarea = () =>
  document.querySelector<HTMLTextAreaElement>("#import-env-text");

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

async function typeText(field: HTMLTextAreaElement | null, value: string) {
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function row(partial: Partial<ImportRow> & { name: string }): ImportRow {
  return {
    proposedKind: "plain",
    value: null,
    state: "new",
    flags: {},
    ...partial,
  };
}

const TEXT = [
  "APP_PORT=8080",
  "API_TOKEN=tok-fictional",
  "LOG_LEVEL=debug",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: .env reference syntax
  "BASE_URL=${PUBLIC_HOST}/app",
  "OLD_NAME=x",
  "bad-name=1",
  "SAME_ONE=kept",
  "DOCKER_REGISTRY=registry.example.test",
].join("\n");

const TEXT_REVIEW = {
  rows: [
    row({ name: "API_TOKEN", proposedKind: "secret" }),
    row({ name: "APP_PORT", value: "8080" }),
    row({
      name: "BASE_URL",
      value: "/app",
      flags: { unresolvedRefs: ["PUBLIC_HOST"] },
    }),
    row({ name: "LOG_LEVEL", value: "debug", state: "conflict" }),
    row({ name: "OLD_NAME", value: "x", flags: { duplicate: true } }),
    row({ name: "SAME_ONE", value: "kept", state: "same" }),
    row({ name: "bad-name", state: "unimportable", reason: "invalidName" }),
  ],
  skipped: [{ name: "DOCKER_REGISTRY", reason: "dockerRegistry" }],
};

async function openPasteReview() {
  api.previewTextImport.mockResolvedValue(TEXT_REVIEW);
  await render(
    <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
  );
  await typeText(textarea(), TEXT);
  await click(button(t.review));
}

/** The dialog with its own open state, as VariablesClient holds it. */
function Controlled() {
  const [open, setOpen] = useState(true);
  return (
    <ImportEnvDialog open={open} onOpenChange={setOpen} environmentId={ENV} />
  );
}

describe("Import .env dialog: paste", () => {
  beforeEach(() => {
    api.saveImport.mockResolvedValue({ imported: 2, overwritten: 0 });
  });

  it("gives instant parse feedback and reviews through the server preview", async () => {
    await render(
      <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
    );
    expect(textarea()?.className).toContain("font-mono");
    await typeText(textarea(), "A=1\nB=2");
    expect(body()).toContain("2 variables found");
    await typeText(textarea(), "A=1\nB='open");
    expect(body()).toContain("Line 2 can't be read");
    expect(button(t.review)?.disabled).toBe(true);

    api.previewTextImport.mockResolvedValue(TEXT_REVIEW);
    await typeText(textarea(), TEXT);
    await click(button(t.review));
    expect(api.previewTextImport).toHaveBeenCalledWith(ENV, TEXT);
    expect(body()).toContain("APP_PORT");
  });

  it("selects only new rows without flags; conflict and flagged off, unimportable disabled", async () => {
    await openPasteReview();
    expect(checked("API_TOKEN")).toBe(true);
    expect(checked("APP_PORT")).toBe(true);
    expect(checked("BASE_URL")).toBe(false);
    expect(checked("LOG_LEVEL")).toBe(false);
    expect(checked("OLD_NAME")).toBe(false);
    expect(checked("bad-name")).toBe(false);
    expect(checkbox("bad-name")?.hasAttribute("data-disabled")).toBe(true);
    expect(body()).toContain(t.state.conflict);
    expect(body()).toContain(t.reason.invalidName);
    expect(body()).toContain("PUBLIC_HOST");
    expect(body()).toContain(t.flag.duplicate);
    expect(button("Import 2 variables")?.disabled).toBe(false);
  });

  it("masks non-plain rows without a length and shows plain values", async () => {
    await openPasteReview();
    const tokenRow = checkbox("API_TOKEN")?.closest("tr");
    // Exactly six dots: the mask says nothing about the length.
    expect(tokenRow?.textContent).toMatch(/(^|[^•])••••••([^•]|$)/);
    expect(tokenRow?.textContent).not.toContain("tok-fictional");
    expect(checkbox("APP_PORT")?.closest("tr")?.textContent).toContain("8080");
  });

  it("collapses the same and skipped groups and says comments and order are not kept", async () => {
    await openPasteReview();
    expect(checkbox("SAME_ONE")).toBeNull();
    expect(body()).toContain(t.notKept);
    expect(names()).not.toContain("SAME_ONE");
    expect(names()).not.toContain("DOCKER_REGISTRY");
    await click(button("1 variable already has this value"));
    expect(names()).toContain("SAME_ONE");
    await click(button("1 variable is skipped"));
    expect(names()).toContain("DOCKER_REGISTRY");
    expect(body()).toContain(t.skipReason.dockerRegistry);
  });

  it("saves the reviewed text with the selected rows and their kinds", async () => {
    const onOpenChange = vi.fn();
    api.previewTextImport.mockResolvedValue(TEXT_REVIEW);
    await render(
      <ImportEnvDialog open onOpenChange={onOpenChange} environmentId={ENV} />
    );
    await typeText(textarea(), TEXT);
    await click(button(t.review));
    await click(checkbox("LOG_LEVEL"));
    await click(checkbox("API_TOKEN"));
    await click(button("Import 2 variables"));
    expect(api.saveImport).toHaveBeenCalledWith(ENV, {
      source: "text",
      text: TEXT,
      rows: [
        { name: "APP_PORT", kind: "plain" },
        { name: "LOG_LEVEL", kind: "plain" },
      ],
    });
    expect(api.toast.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("lets a row's kind be changed before saving", async () => {
    await openPasteReview();
    await click(
      document.querySelector('[aria-label="Kind of APP_PORT"]') ?? undefined
    );
    const secret = [...document.querySelectorAll('[role="option"]')].find(
      (o) => o.textContent?.trim() === messages.variables.kind.secret
    );
    await click(secret);
    // A row turned secret is masked, though the server proposed it plain.
    const portRow = checkbox("APP_PORT")?.closest("tr");
    expect(portRow?.textContent).not.toContain("8080");
    expect(portRow?.textContent).toContain("••••••");
    await click(button("Import 2 variables"));
    expect(api.saveImport.mock.calls[0]?.[1].rows).toContainEqual({
      name: "APP_PORT",
      kind: "secret",
    });
  });

  it("ignores a preview that answers after the text was edited", async () => {
    let answer: (value: typeof TEXT_REVIEW) => void = () => {};
    api.previewTextImport.mockImplementation(
      () => new Promise((resolve) => (answer = resolve))
    );
    await render(
      <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
    );
    await typeText(textarea(), TEXT);
    await click(button(t.review));
    await typeText(textarea(), "OTHER=1");
    await act(async () => answer(TEXT_REVIEW));
    await flush();
    expect(checkbox("APP_PORT")).toBeNull();
    expect(button("Import 0 variables")?.disabled ?? true).toBe(true);
  });

  it("keeps a paste refusal on the Paste tab", async () => {
    api.previewTextImport.mockRejectedValue(
      new ApiError(400, "x", "envParseError", { line: 3 })
    );
    await render(
      <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
    );
    await typeText(textarea(), "A=1");
    await click(button(t.review));
    expect(body()).toContain("The .env can't be read at line 3.");
    await click(tab(t.sourceUpload));
    expect(body()).not.toContain("The .env can't be read at line 3.");
  });

  it("leaves no pasted text or secret in the query client after closing", async () => {
    api.previewTextImport.mockResolvedValue(TEXT_REVIEW);
    api.saveImport.mockResolvedValue({ imported: 2, overwritten: 0 });
    await render(<Controlled />);
    await typeText(textarea(), TEXT);
    await click(button(t.review));
    await click(button("Import 2 variables"));
    expect(textarea()).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const cached = JSON.stringify([
      queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
    ]);
    expect(cached).not.toContain("tok-fictional");
    expect(cached).not.toContain("APP_PORT=8080");
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it("drops the review when the text is edited", async () => {
    await openPasteReview();
    await typeText(textarea(), "OTHER=1");
    expect(checkbox("APP_PORT")).toBeNull();
  });

  it("words coded refusals in the user's language", async () => {
    api.previewTextImport.mockRejectedValue(
      new ApiError(413, "English prose", "envTextTooLarge", {
        maxBytes: 262144,
      })
    );
    await render(
      <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
    );
    await typeText(textarea(), "A=1");
    await click(button(t.review));
    expect(body()).toContain("The .env text is larger than 256 KiB.");
    expect(body()).not.toContain("English prose");
  });

  it("shows the strong sign-in refusal the reveal shows", async () => {
    // apiFetch already swaps this code's message for the localized guidance.
    const guidance = messages.strongSignIn.refusal;
    api.previewTextImport.mockRejectedValue(
      new ApiError(403, guidance, "strong_sign_in_required")
    );
    await render(
      <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
    );
    await typeText(textarea(), "A=1");
    await click(button(t.review));
    expect(body()).toContain(guidance);
  });

  it("opens prefilled on Paste and reviews it at once", async () => {
    api.previewTextImport.mockResolvedValue(TEXT_REVIEW);
    await render(
      <ImportEnvDialog
        open
        onOpenChange={() => {}}
        environmentId={ENV}
        initialText={TEXT}
      />
    );
    await flush();
    expect(textarea()?.value).toBe(TEXT);
    expect(api.previewTextImport).toHaveBeenCalledWith(ENV, TEXT);
  });
});

describe("Import .env dialog: upload", () => {
  async function upload(file: File, onValue: (v: string) => void = () => {}) {
    if (!document.querySelector("#import-env-file")) {
      await click(tab(t.sourceUpload));
    }
    const input = document.querySelector<HTMLInputElement>("#import-env-file");
    expect(input).not.toBeNull();
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    Object.defineProperty(input, "value", {
      get: () => "",
      set: onValue,
      configurable: true,
    });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await flush();
  }

  it("reads the file in the browser and reviews it like a paste", async () => {
    api.previewTextImport.mockResolvedValue(TEXT_REVIEW);
    await render(
      <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
    );
    await upload(new File([TEXT], ".env", { type: "text/plain" }));
    expect(api.previewTextImport).toHaveBeenCalledWith(ENV, TEXT);
    expect(checked("APP_PORT")).toBe(true);
  });

  it("clears the input so the same file can be picked again", async () => {
    api.previewTextImport.mockResolvedValue(TEXT_REVIEW);
    const onValue = vi.fn();
    await render(
      <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
    );
    await upload(new File([TEXT], ".env"), onValue);
    expect(onValue).toHaveBeenCalledWith("");
  });

  it("keeps the second file's review when the first answers late", async () => {
    const SECOND = "APP_PORT=9090";
    let answerFirst: (value: typeof TEXT_REVIEW) => void = () => {};
    api.previewTextImport.mockImplementation((_env: string, text: string) =>
      text === SECOND
        ? Promise.resolve({
            rows: [row({ name: "APP_PORT", value: "9090" })],
            skipped: [],
          })
        : new Promise((resolve) => (answerFirst = resolve))
    );
    await render(
      <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
    );
    await upload(new File([TEXT], "first.env"));
    await upload(new File([SECOND], "second.env"));
    await act(async () => answerFirst(TEXT_REVIEW));
    await flush();
    expect(checkbox("API_TOKEN")).toBeNull();
    expect(checkbox("APP_PORT")?.closest("tr")?.textContent).toContain("9090");
  });

  it("warns when the file is not UTF-8 and still reviews it", async () => {
    api.previewTextImport.mockResolvedValue(TEXT_REVIEW);
    await render(
      <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
    );
    await upload(
      new File([new Uint8Array([0x41, 0x3d, 0xe9, 0x0a])], "latin1.env")
    );
    expect(body()).toContain(t.uploadNotUtf8);
    expect(api.previewTextImport).toHaveBeenCalled();
  });

  it("refuses a file over 256 KiB without sending it", async () => {
    await render(
      <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
    );
    await upload(new File(["A=".padEnd(256 * 1024 + 1, "x")], ".env"));
    expect(api.previewTextImport).not.toHaveBeenCalled();
    expect(body()).toContain("The file is larger than 256 KiB.");
  });
});

const SERVER_REVIEW = {
  dirs: [
    {
      serverName: "kestrel-app-1",
      deployDir: "/srv/kestrel/a",
      status: "ok",
      fingerprint: "fp-a",
    },
    {
      serverName: "kestrel-app-2",
      deployDir: "/srv/kestrel/b",
      status: "ok",
      fingerprint: "fp-b",
    },
    {
      serverName: "kestrel-app-3",
      deployDir: "/srv/kestrel/c",
      status: "parseError",
      line: 7,
    },
    {
      serverName: "kestrel-app-4",
      deployDir: "/srv/kestrel/d",
      status: "hostKeyMismatch",
    },
  ],
  rows: [
    row({
      name: "APP_MODE",
      flags: { differsAcrossDirs: true },
      sources: [
        {
          serverName: "kestrel-app-1",
          deployDir: "/srv/kestrel/a",
          valueId: "fp-a:1",
          value: "blue",
        },
        {
          serverName: "kestrel-app-2",
          deployDir: "/srv/kestrel/b",
          valueId: "fp-b:1",
          value: "green",
        },
      ],
    }),
    row({
      name: "APP_PORT",
      value: "8080",
      sources: [
        {
          serverName: "kestrel-app-1",
          deployDir: "/srv/kestrel/a",
          valueId: "fp-a:2",
          value: "8080",
        },
      ],
    }),
  ],
  skipped: [],
};

describe("Import .env dialog: from server", () => {
  async function openServer() {
    api.readServerImport.mockResolvedValue(SERVER_REVIEW);
    await render(
      <ImportEnvDialog open onOpenChange={() => {}} environmentId={ENV} />
    );
    await click(tab(t.sourceServer));
    await flush();
  }

  it("reads the deploy dirs and words each dir's status", async () => {
    await openServer();
    expect(api.readServerImport).toHaveBeenCalledWith(ENV);
    expect(body()).toContain("/srv/kestrel/a");
    expect(body()).toContain(t.dirStatus.ok);
    expect(body()).toContain("Can't be read at line 7");
    expect(body()).toContain(t.dirStatus.hostKeyMismatch);
  });

  it("leaves a row the dirs disagree on off until a dir is chosen, then saves its value", async () => {
    api.saveImport.mockResolvedValue({ imported: 2, overwritten: 0 });
    await openServer();
    expect(checked("APP_MODE")).toBe(false);
    expect(body()).toContain(t.flag.differsAcrossDirs);
    await click(
      document.querySelector('[aria-label="Deploy dir for APP_MODE"]') ??
        undefined
    );
    const option = [...document.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent?.includes("/srv/kestrel/b")
    );
    await click(option);
    expect(checked("APP_MODE")).toBe(true);
    expect(checkbox("APP_MODE")?.closest("tr")?.textContent).toContain("green");
    await click(button("Import 2 variables"));
    expect(api.saveImport).toHaveBeenCalledWith(ENV, {
      source: "server",
      dirs: [
        { deployDir: "/srv/kestrel/a", fingerprint: "fp-a" },
        { deployDir: "/srv/kestrel/b", fingerprint: "fp-b" },
      ],
      rows: [
        { name: "APP_MODE", kind: "plain", valueId: "fp-b:1" },
        { name: "APP_PORT", kind: "plain" },
      ],
    });
  });

  it("reads the files again when one changed since the review", async () => {
    api.saveImport.mockRejectedValue(
      new ApiError(409, "changed", "envFileChanged")
    );
    await openServer();
    await click(button("Import 1 variable"));
    expect(api.readServerImport).toHaveBeenCalledTimes(2);
    expect(body()).toContain(t.errors.envFileChanged);
  });
});

describe("Add variable: name-field paste", () => {
  const listing = { envFileManaged: false, hasServices: true, variables: [] };

  async function openForm() {
    await render(<VariablesClient environmentId={ENV} listing={listing} />);
    await click(button(messages.variables.add));
  }

  function paste(text: string): Event {
    const input = document.querySelector<HTMLInputElement>("#variable-name");
    expect(input).not.toBeNull();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { getData: () => text },
    });
    act(() => {
      input?.dispatchEvent(event);
    });
    return event;
  }

  it("shows Import .env next to the template button", async () => {
    await render(<VariablesClient environmentId={ENV} listing={listing} />);
    expect(button(t.button)).toBeTruthy();
  });

  it("hides Import .env without variable write", async () => {
    await render(
      <VariablesClient environmentId={ENV} listing={listing} />,
      "qa"
    );
    expect(button(t.button)).toBeUndefined();
  });

  it("opens the dialog on Paste, prefilled, for a multi-line paste", async () => {
    api.previewTextImport.mockResolvedValue(TEXT_REVIEW);
    await openForm();
    const event = paste("APP_PORT=8080\nLOG_LEVEL=debug");
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(textarea()?.value).toBe("APP_PORT=8080\nLOG_LEVEL=debug");
  });

  it("opens the dialog for a single line with =", async () => {
    api.previewTextImport.mockResolvedValue(TEXT_REVIEW);
    await openForm();
    const event = paste("APP_PORT=8080");
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(textarea()?.value).toBe("APP_PORT=8080");
  });

  it("pastes a plain name normally", async () => {
    await openForm();
    const event = paste("APP_PORT");
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(textarea()).toBeNull();
  });
});

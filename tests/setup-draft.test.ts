import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/locales";
import {
  applyCopySource,
  buildSetupInput,
  type CopySourceLike,
  type DraftContext,
  defaultDeployDir,
  draftForHandoff,
  draftFromRouterState,
  emptyDraft,
  entryServiceFromRouterState,
  parseSetupInput,
  SETUP_DRAFT_STATE_KEY,
  SETUP_ENTRY_SERVICE_STATE_KEY,
  syncTargets,
  variableHandling,
} from "@/lib/setup/draft";
import {
  issueMessagePath,
  SETUP_ISSUE_MESSAGE_CODES,
} from "@/lib/setup/issues";

const UUID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const SERVER = "0197f3a0-1b2c-7def-8000-0123456789c1";

const ctx: DraftContext = {
  appId: UUID,
  projectKey: "HRIS",
  slug: "staging",
  suggestedServices: [
    { role: "backend", serviceName: "hris-staging-api-1" },
    { role: "frontend", serviceName: "hris-staging-web-1" },
  ],
  suggestedEntryPort: 8104,
  defaultZoneId: UUID,
};

const source: CopySourceLike = {
  environment: { id: UUID },
  serverId: SERVER,
  targets: [
    {
      componentKey: "hris",
      sourceBranch: "release/1.x",
      autoDeploy: true,
      services: ["api", "web"],
      tagVariable: "IMAGE_TAG",
      preStartCommand: null,
      healthUrl: null,
      healthTimeoutSeconds: 240,
      backupBeforeDeploy: true,
    },
  ],
  database: { kind: "shared", databaseHostId: UUID },
  domain: { kind: "tunnel", zoneId: UUID, accessPolicyId: "pol-staff" },
  variables: [
    {
      name: "APP_NAME",
      kind: "plain",
      escrow: false,
      hasValue: true,
      copyable: true,
      value: "Hris",
    },
    // A server never sends this; the draft must not keep it if one did.
    {
      name: "SMTP_PASSWORD",
      kind: "secret",
      escrow: false,
      hasValue: true,
      copyable: true,
      value: "leaked-secret",
    } as CopySourceLike["variables"][number],
    {
      name: "DATA_KEY",
      kind: "secret",
      escrow: true,
      hasValue: true,
      copyable: false,
    },
    // Escrowed plain: a server sends no value; if one did, it is not kept.
    {
      name: "ESCROW_PLAIN",
      kind: "plain",
      escrow: true,
      hasValue: true,
      copyable: false,
      value: "escrow-leak",
    } as CopySourceLike["variables"][number],
    {
      name: "SESSION",
      kind: "generated",
      escrow: false,
      hasValue: true,
      copyable: false,
    },
  ],
};

describe("defaults", () => {
  it("puts the deploy dir under /deployments/<project key>-<slug>", () => {
    expect(defaultDeployDir(ctx)).toBe("/deployments/hris-staging");
    // One stack per app: every component shares the directory.
    const { input } = buildSetupInput(
      emptyDraft(UUID, [{ componentKey: "api" }, { componentKey: "web" }]),
      ctx
    );
    expect(
      (input as { targets: { deployDir: string }[] }).targets.map(
        (t) => t.deployDir
      )
    ).toEqual(["/deployments/hris-staging", "/deployments/hris-staging"]);
  });

  it("builds the input from the draft with the defaults filled in", () => {
    const draft = {
      ...emptyDraft(UUID, [{ componentKey: "hris" }]),
      name: "Staging",
      serverId: SERVER,
    };
    draft.targets[0] = { ...draft.targets[0], services: "api, web" } as never;
    const { input, issues } = buildSetupInput(draft, ctx);
    expect(issues).toEqual([]);
    const parsed = parseSetupInput(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.targets[0]?.deployDir).toBe(
      "/deployments/hris-staging"
    );
    expect(parsed.input.targets[0]?.services).toEqual(["api", "web"]);
    expect(parsed.input.services).toEqual(ctx.suggestedServices);
  });

  it("keeps a container name the user edited", () => {
    const draft = {
      ...emptyDraft(UUID, [{ componentKey: "hris" }]),
      serviceNames: { backend: "hris-custom-1" },
    };
    const { input } = buildSetupInput(draft, ctx);
    expect((input as { services: unknown }).services).toEqual([
      { role: "backend", serviceName: "hris-custom-1" },
      { role: "frontend", serviceName: "hris-staging-web-1" },
    ]);
  });

  it("uses the suggested entry port, and asks for one when there is none", () => {
    const draft = {
      ...emptyDraft(UUID, [{ componentKey: "hris" }]),
      domain: {
        kind: "tunnel" as const,
        zoneId: "",
        label: null,
        accessPolicyId: "pol-staff",
        entryPort: null,
        hostname: "",
      },
    };
    const withPort = buildSetupInput(draft, ctx);
    expect(
      (withPort.input as { domain: { entryPort: number } }).domain.entryPort
    ).toBe(8104);
    const without = buildSetupInput(draft, {
      ...ctx,
      suggestedEntryPort: null,
    });
    expect(without.issues).toContainEqual({
      field: "domain.entryPort",
      code: "required",
    });
    // The probe still asks the server, which is where the suggestion comes from.
    const probe = buildSetupInput(draft, {
      ...ctx,
      suggestedEntryPort: null,
      probe: true,
    });
    expect(probe.issues).toEqual([]);
  });

  it("reports a schema failure as an invalid issue at the field", () => {
    const draft = emptyDraft(UUID, [{ componentKey: "hris" }]);
    const parsed = parseSetupInput(buildSetupInput(draft, ctx).input);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toContainEqual({
      field: "targets.0.services",
      code: "invalid",
    });
  });
});

describe("copying from an environment", () => {
  const base = emptyDraft(UUID, [{ componentKey: "hris" }]);

  it("fills the server, target, database, domain and variables", () => {
    const draft = applyCopySource(base, source, [SERVER]);
    expect(draft.copyFromEnvironmentId).toBe(UUID);
    expect(draft.serverId).toBe(SERVER);
    expect(draft.targets[0]).toMatchObject({
      sourceBranch: "release/1.x",
      autoDeploy: true,
      services: "api, web",
      backupBeforeDeploy: true,
      deployDir: null,
    });
    expect(draft.database).toMatchObject({
      kind: "shared",
      databaseHostId: UUID,
    });
    expect(draft.domain).toMatchObject({
      kind: "tunnel",
      accessPolicyId: "pol-staff",
      entryPort: null,
    });
    expect(draft.variables.map((v) => v.name)).toEqual([
      "APP_NAME",
      "SMTP_PASSWORD",
      "DATA_KEY",
      "ESCROW_PLAIN",
      "SESSION",
      // The shared database needs its password variable.
      "DB_PASSWORD",
    ]);
  });

  it("leaves a server the caller may not use unchosen", () => {
    expect(applyCopySource(base, source, []).serverId).toBe("");
  });

  it("never keeps a secret value, and says how each value is handled", () => {
    const draft = applyCopySource(base, source, [SERVER]);
    expect(JSON.stringify(draft)).not.toContain("leaked-secret");
    expect(JSON.stringify(draft)).not.toContain("escrow-leak");
    const by = Object.fromEntries(
      draft.variables.map((v) => [v.name, variableHandling(v)])
    );
    expect(by).toEqual({
      APP_NAME: "enter",
      SMTP_PASSWORD: "copy",
      DATA_KEY: "enter",
      ESCROW_PLAIN: "enter",
      SESSION: "generate",
      DB_PASSWORD: "generate",
    });
    const entries = (
      buildSetupInput(draft, ctx).input as {
        variables: Record<string, unknown>[];
      }
    ).variables;
    expect(entries.find((e) => e.name === "SMTP_PASSWORD")).toEqual({
      name: "SMTP_PASSWORD",
      kind: "secret",
      copy: true,
    });
    expect(entries.find((e) => e.name === "SESSION")).toEqual({
      name: "SESSION",
      kind: "generated",
    });
    expect(entries.find((e) => e.name === "APP_NAME")).toMatchObject({
      value: "Hris",
    });
  });

  it("requires a value for a secret that is not copyable", () => {
    const draft = applyCopySource(base, source, [SERVER]);
    const { issues } = buildSetupInput(draft, ctx);
    expect(issues).toContainEqual({
      field: "variables.DATA_KEY",
      code: "valueRequired",
    });
    // An escrowed plain value must be entered too, not re-sent as prefilled.
    expect(issues).toContainEqual({
      field: "variables.ESCROW_PLAIN",
      code: "valueRequired",
    });
  });
});

describe("issue messages", () => {
  function messages(locale: string): Record<string, unknown> {
    return JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));
  }
  const at = (tree: unknown, path: string) =>
    path
      .split(".")
      .reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], tree);

  it("lists every code the setup can report", async () => {
    // The tables the codes come from (a new code must be added to the list).
    const { SETUP_ERRORS } = await import(
      "@/server/services/environment-setup"
    );
    const { VARIABLE_ERRORS } = await import("@/server/services/variables");
    const { TARGET_ERRORS } = await import("@/server/services/deploys");
    const { DOMAIN_ERRORS } = await import("@/lib/domains/errors");
    for (const table of [
      SETUP_ERRORS,
      VARIABLE_ERRORS,
      TARGET_ERRORS,
      DOMAIN_ERRORS,
    ]) {
      for (const code of Object.keys(table)) {
        expect(SETUP_ISSUE_MESSAGE_CODES, code).toContain(code);
      }
    }
  });

  for (const locale of locales) {
    it(`${locale} has a message for every code`, () => {
      const tree = messages(locale);
      for (const code of SETUP_ISSUE_MESSAGE_CODES) {
        expect(
          typeof at(tree, issueMessagePath(code)),
          `${locale} ${code}`
        ).toBe("string");
      }
      expect(typeof at(tree, issueMessagePath("not-a-code"))).toBe("string");
    });
  }
});

describe("syncTargets", () => {
  it("adds a target per new component with its branch and detected services", () => {
    const draft = emptyDraft(UUID, []);
    const next = syncTargets(draft, [
      { componentKey: "hris", branch: "develop", services: ["api", "web"] },
    ]);
    expect(next.targets).toHaveLength(1);
    expect(next.targets[0]).toMatchObject({
      componentKey: "hris",
      sourceBranch: "develop",
      services: "api, web",
    });
  });

  it("keeps what the user set, follows an untouched branch and drops removed components", () => {
    const first = syncTargets(emptyDraft(UUID, []), [
      { componentKey: "hris", branch: "main", services: [] },
      { componentKey: "old", branch: "main", services: [] },
    ]);
    const edited = {
      ...first,
      targets: first.targets.map((t) =>
        t.componentKey === "hris"
          ? { ...t, autoDeploy: true, services: "api" }
          : t
      ),
    };
    const next = syncTargets(
      edited,
      [{ componentKey: "hris", branch: "release", services: ["web"] }],
      { hris: "main", old: "main" }
    );
    expect(next.targets).toHaveLength(1);
    expect(next.targets[0]).toMatchObject({
      sourceBranch: "release",
      autoDeploy: true,
      services: "api",
    });
    // A branch the user changed is theirs.
    const custom = {
      ...next,
      targets: next.targets.map((t) => ({ ...t, sourceBranch: "qa" })),
    };
    expect(
      syncTargets(
        custom,
        [{ componentKey: "hris", branch: "other", services: [] }],
        { hris: "release" }
      ).targets[0]?.sourceBranch
    ).toBe("qa");
  });
});

describe("draft hand-over", () => {
  const draft = {
    ...emptyDraft(UUID, [{ componentKey: "hris" }]),
    variables: [
      {
        key: "k",
        name: "TOKEN",
        kind: "secret" as const,
        escrow: false,
        fromSource: false,
        copyable: false,
        value: "super-secret",
        required: false,
      },
      {
        key: "p",
        name: "APP_NAME",
        kind: "plain" as const,
        escrow: false,
        fromSource: false,
        copyable: false,
        value: "Hris",
        required: false,
      },
    ],
  };

  it("drops typed secret values and makes them required again", () => {
    const out = draftForHandoff(draft);
    expect(JSON.stringify(out)).not.toContain("super-secret");
    expect(out.variables[0]).toMatchObject({ value: "", required: true });
    expect(out.variables[1]).toMatchObject({ value: "Hris" });
  });

  it("reads a draft back from router state, and nothing else", () => {
    const state = { [SETUP_DRAFT_STATE_KEY]: draftForHandoff(draft) };
    expect(draftFromRouterState(state)?.name).toBe(draft.name);
    expect(draftFromRouterState({ [SETUP_DRAFT_STATE_KEY]: { x: 1 } })).toBe(
      undefined
    );
    expect(draftFromRouterState(undefined)).toBe(undefined);
    expect(draftFromRouterState({})).toBe(undefined);
    expect(
      entryServiceFromRouterState({ [SETUP_ENTRY_SERVICE_STATE_KEY]: "web" })
    ).toBe("web");
    expect(entryServiceFromRouterState({})).toBe(undefined);
  });
});

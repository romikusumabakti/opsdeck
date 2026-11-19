import { describe, expect, it } from "vitest";
import {
  keepsCopiedVariable,
  mergeTemplates,
  type TemplateDefinition,
} from "@/lib/variables/template-merge";

// The variable templates of an environment's services, merged per name
// (Stage 8 spec: strictest safety properties; kind/default conflicts are the
// user's pick).

const row = (
  componentKey: string,
  name: string,
  over: Partial<TemplateDefinition> = {}
): TemplateDefinition => ({
  componentKey,
  name,
  kind: "plain",
  required: false,
  defaultValue: null,
  generatedLength: null,
  escrow: false,
  description: null,
  ...over,
});

describe("mergeTemplates", () => {
  it("keeps one template for identical definitions of several services", () => {
    const merged = mergeTemplates([
      row("kestrel-web", "APP_URL", { defaultValue: "{url}" }),
      row("kestrel-api", "APP_URL", { defaultValue: "{url}" }),
    ]);
    expect(merged).toEqual([
      {
        name: "APP_URL",
        kind: "plain",
        defaultValue: "{url}",
        required: false,
        escrow: false,
        generatedLength: null,
        description: null,
        componentKeys: ["kestrel-api", "kestrel-web"],
        conflict: null,
      },
    ]);
  });

  it("takes the strictest required, escrow and generated length", () => {
    const [merged] = mergeTemplates([
      row("kestrel-api", "SESSION_KEY", {
        kind: "generated",
        generatedLength: 48,
        escrow: true,
      }),
      row("kestrel-web", "SESSION_KEY", {
        kind: "generated",
        generatedLength: 64,
        required: true,
        description: "Signs sessions",
      }),
    ]);
    expect(merged).toMatchObject({
      kind: "generated",
      required: true,
      escrow: true,
      generatedLength: 64,
      description: "Signs sessions",
      conflict: null,
    });
  });

  it("reports a differing kind or default as a conflict, in service order", () => {
    const merged = mergeTemplates([
      row("kestrel-web", "MAIL_FROM", { defaultValue: "web@example.test" }),
      row("kestrel-api", "MAIL_FROM", { defaultValue: "api@example.test" }),
      row("kestrel-worker", "MAIL_FROM", { defaultValue: "api@example.test" }),
      row("kestrel-api", "SMTP_PASSWORD", { kind: "plain" }),
      row("kestrel-web", "SMTP_PASSWORD", { kind: "secret", required: true }),
    ]);
    expect(merged.map((t) => t.name)).toEqual(["MAIL_FROM", "SMTP_PASSWORD"]);
    expect(merged[0]).toMatchObject({
      kind: "plain",
      defaultValue: null,
      conflict: [
        {
          componentKeys: ["kestrel-api", "kestrel-worker"],
          kind: "plain",
          defaultValue: "api@example.test",
        },
        {
          componentKeys: ["kestrel-web"],
          kind: "plain",
          defaultValue: "web@example.test",
        },
      ],
    });
    // Unresolved, a value one service keeps secret is never proposed plain;
    // it still counts as required.
    expect(merged[1]).toMatchObject({
      kind: "secret",
      required: true,
      conflict: [
        { componentKeys: ["kestrel-api"], kind: "plain" },
        { componentKeys: ["kestrel-web"], kind: "secret" },
      ],
    });
  });

  it("resolves a conflict by the chosen service's definition, keeping the strictest flags", () => {
    const [merged] = mergeTemplates(
      [
        row("kestrel-web", "MAIL_FROM", {
          defaultValue: "web@example.test",
          escrow: true,
        }),
        row("kestrel-api", "MAIL_FROM", {
          defaultValue: "api@example.test",
          required: true,
        }),
      ],
      { MAIL_FROM: "kestrel-web" }
    );
    expect(merged).toMatchObject({
      kind: "plain",
      defaultValue: "web@example.test",
      required: true,
      escrow: true,
      conflict: null,
    });
  });

  it("ignores a choice naming a service without the template", () => {
    const [merged] = mergeTemplates(
      [
        row("kestrel-web", "MAIL_FROM", { defaultValue: "a@example.test" }),
        row("kestrel-api", "MAIL_FROM", { defaultValue: "b@example.test" }),
      ],
      { MAIL_FROM: "kestrel-worker" }
    );
    expect(merged?.conflict).toHaveLength(2);
  });

  it("is deterministic whatever order the rows come in", () => {
    const rows = [
      row("b-svc", "X", { defaultValue: "1" }),
      row("a-svc", "X", { defaultValue: "2" }),
      row("a-svc", "A"),
    ];
    expect(mergeTemplates(rows)).toEqual(mergeTemplates([...rows].reverse()));
  });
});

describe("keepsCopiedVariable", () => {
  const target = new Set(["kestrel-api"]);
  it("keeps environment-wide variables and those of shared services", () => {
    expect(keepsCopiedVariable("TZ", [], target, new Set())).toBe(true);
    expect(
      keepsCopiedVariable(
        "API_KEY",
        ["kestrel-api", "kestrel-web"],
        target,
        new Set()
      )
    ).toBe(true);
  });
  it("drops one only services the copy leaves out define, unless the copy's templates name it", () => {
    expect(
      keepsCopiedVariable("WEB_KEY", ["kestrel-web"], target, new Set())
    ).toBe(false);
    expect(
      keepsCopiedVariable(
        "WEB_KEY",
        ["kestrel-web"],
        target,
        new Set(["WEB_KEY"])
      )
    ).toBe(true);
  });
});

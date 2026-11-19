import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/locales";

// The Assistant database toggle's wiring that has no runtime of its own to
// test: its wording in every locale, the activity entry, the toggle's warning
// copy, and that nothing but the toggle writes the assistant_db_* columns (a
// duplicated or copied environment must start with the access off).

type Messages = Record<string, Record<string, unknown>>;
const messages = (locale: string): Messages =>
  JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));

function leaves(node: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      for (const [k, v] of leaves(value, path)) out.set(k, v);
    }
  } else {
    out.set(prefix, node);
  }
  return out;
}

const ERROR_KEYS = [
  "assistantDbNoDatabase",
  "assistantDbUnavailable",
  "assistantDbProvisionFailed",
  "assistantDbDropFailed",
  "assistantDbAccessBlocksRebind",
  "assistantDbLoginExists",
  "assistantDbLoginMappedElsewhere",
];

describe("assistant database messages", () => {
  const en = leaves(messages("en").environmentSettings?.assistantDb);
  for (const locale of locales) {
    it(`${locale} words the toggle, its errors and its activity entry`, () => {
      const m = messages(locale);
      const own = leaves(m.environmentSettings?.assistantDb);
      expect([...own.keys()].sort()).toEqual([...en.keys()].sort());
      const all: [string, unknown][] = [
        ...own,
        ...ERROR_KEYS.map((k) => [k, m.actionErrors?.[k]] as [string, unknown]),
        ["activity", m.activity?.environmentAssistantDbAccess],
      ];
      for (const [key, value] of all) {
        expect(typeof value, key).toBe("string");
        expect(String(value).trim(), key).not.toBe("");
        // Parses as ICU in that locale.
        new IntlMessageFormat(String(value), locale);
      }
      for (const token of ["{actor}", "{environment}", "{enabled, select"]) {
        expect(m.activity?.environmentAssistantDbAccess, token).toContain(
          token
        );
      }
      expect(own.get("enabledAs")).toContain("{login}");
      expect(m.teardown?.steps).toHaveProperty("drop_assistant_db_login");
      for (const key of [
        "assistantDbLoginExists",
        "assistantDbLoginMappedElsewhere",
      ]) {
        expect(m.actionErrors?.[key], key).toContain("{login}");
      }
      expect(own.get("leftover")).toContain("{login}");
    });
  }

  it("the warning names real participant data and the renamed-view gap", () => {
    const warning = String(
      leaves(messages("en").environmentSettings?.assistantDb).get("warning")
    );
    expect(warning).toMatch(/real participant data/);
    expect(warning).toMatch(/view that renames a column/);
  });

  it("the activity page renders environment.assistantDbAccess", () => {
    const page = readFileSync(
      "web/routes/$locale/_app/admin.activity.tsx",
      "utf8"
    );
    expect(page).toMatch(
      /case "environment\.assistantDbAccess":\s*return t\("environmentAssistantDbAccess"/
    );
  });

  it("the Database tab shows the toggle with its warning and disabled reason", () => {
    const tab = readFileSync(
      "web/routes/$locale/_app/-components/env/settings/assistant-db-access.tsx",
      "utf8"
    );
    expect(tab).toContain('t("warning")');
    expect(tab).toContain("unavailable.$" + "{reason}");
    expect(tab).toContain("disabled={!canManageServers || blocked || busy}");
    expect(
      readFileSync(
        "web/routes/$locale/_app/-components/env/settings/database-tab.tsx",
        "utf8"
      )
    ).toContain("<AssistantDbAccess");
  });
});

describe("teardown step migration", () => {
  it("adds drop_assistant_db_login to teardown_step_kind, expand-only", () => {
    const sql = readFileSync(
      "drizzle/20261201000001_teardown_assistant_db_login/migration.sql",
      "utf8"
    );
    expect(sql.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(sql).toContain(
      `ALTER TYPE "teardown_step_kind" ADD VALUE 'drop_assistant_db_login'`
    );
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/);
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("who writes the assistant_db_* columns", () => {
  it("only the toggle's service (and the secret plumbing) names them", () => {
    const allowed = new Set([
      "lib/db/schema.ts",
      // Decrypts the password for server use, strips it for clients.
      "lib/environments.ts",
      "lib/assistant-db/login.ts",
      "server/services/environment-assistant-db.ts",
      // The teardown step that drops the login.
      "lib/teardown/assistant-db.ts",
      "lib/teardown/repository.ts",
      "lib/teardown/plan.ts",
      // The rebind guard reads them.
      "server/services/environments.ts",
    ]);
    const offenders = [...sources("lib"), ...sources("server")].filter(
      (path) =>
        !allowed.has(path) &&
        /assistantDb(Enabled|Login|Password|EnabledAt|EnabledBy)\b/.test(
          readFileSync(path, "utf8")
        )
    );
    expect(offenders).toEqual([]);
    // The rebind guard only reads them.
    const environments = readFileSync(
      "server/services/environments.ts",
      "utf8"
    );
    expect(environments).not.toMatch(/assistantDb\w+\s*:/);
  });
});

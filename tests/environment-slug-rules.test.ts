import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/locales";
import { RESERVED_ENV_SLUGS } from "@/lib/reserved-paths";
import {
  baseEnvSlug,
  ENV_SLUG_MAX_LENGTH,
  envSlugProblem,
  slugify,
} from "@/lib/setup/slug";

describe("baseEnvSlug", () => {
  it("derives a lowercase URL name from the environment name", () => {
    expect(baseEnvSlug("Dev 1")).toBe("dev-1");
    expect(baseEnvSlug("  QA (Kestrel)  ")).toBe("qa-kestrel");
    expect(baseEnvSlug("!!!")).toBe("env");
  });

  it("caps a new default at 40 characters without a trailing hyphen", () => {
    expect(ENV_SLUG_MAX_LENGTH).toBe(40);
    const slug = baseEnvSlug(`${"a".repeat(39)} b c`);
    expect(slug).toHaveLength(39);
    expect(slug).toBe("a".repeat(39));
    expect(baseEnvSlug("x".repeat(100))).toHaveLength(40);
  });
});

describe("slugify", () => {
  it("cuts to the given length and trims hyphens left at the cut", () => {
    expect(slugify("panel-canary-2", 64)).toBe("panel-canary-2");
    expect(slugify("abc def", 4)).toBe("abc");
    expect(slugify("---", 10)).toBe("");
  });
});

describe("envSlugProblem", () => {
  it("accepts lowercase words joined by single hyphens, 1 to 40 characters", () => {
    for (const ok of ["a", "qa", "qa-1", "dev-2-west", "x".repeat(40)]) {
      expect(envSlugProblem(ok), ok).toBeNull();
    }
  });

  it("refuses any other shape as invalid", () => {
    for (const bad of [
      "",
      "QA",
      "-qa",
      "qa-",
      "qa--1",
      "qa_1",
      "qa 1",
      "qä",
      "x".repeat(41),
    ]) {
      expect(envSlugProblem(bad), JSON.stringify(bad)).toBe(
        "environmentSlugInvalid"
      );
    }
  });

  it("refuses a project sub-route as reserved", () => {
    for (const reserved of RESERVED_ENV_SLUGS) {
      expect(envSlugProblem(reserved), reserved).toBe(
        "environmentSlugReserved"
      );
    }
  });
});

type Catalog = {
  actionErrors: Record<string, string>;
  activity: Record<string, string>;
};
const catalog = (locale: string): Catalog =>
  JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));

describe("environment slug messages", () => {
  for (const locale of locales) {
    it(`${locale} words every rename refusal and the activity sentence`, () => {
      const { actionErrors, activity } = catalog(locale);
      for (const key of [
        "environmentSlugInvalid",
        "environmentSlugReserved",
        "environmentSlugTaken",
        "environmentSlugAliasTaken",
      ]) {
        expect(actionErrors[key]?.trim(), key).toBeTruthy();
      }
      for (const token of ["{actor}", "{environment}", "{from}", "{to}"]) {
        expect(activity.environmentSlugChanged, token).toContain(token);
      }
    });
  }

  it("the activity page renders environment.slugChanged", () => {
    const page = readFileSync(
      "web/routes/$locale/_app/admin.activity.tsx",
      "utf8"
    );
    expect(page).toMatch(
      /case "environment\.slugChanged":\s*return t\("environmentSlugChanged"/
    );
  });
});

describe("environment slug aliases migration", () => {
  const sql = readFileSync(
    "drizzle/20261129000000_environment_slug_aliases/migration.sql",
    "utf8"
  );

  it("follows the migrator rules and is expand only", () => {
    expect(sql.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/);
    expect(sql).not.toMatch(/ALTER TABLE "environments"/);
  });

  it("keys aliases by (project, slug) and drops them with the environment", () => {
    expect(sql).toContain('CREATE TABLE "environment_slug_aliases"');
    expect(sql).toContain(
      'CONSTRAINT "environment_slug_aliases_pkey" PRIMARY KEY("project_id","slug")'
    );
    expect(sql).toMatch(
      /"environment_slug_aliases_environment_id_fkey" FOREIGN KEY \("environment_id"\) REFERENCES "environments"\("id"\) ON DELETE CASCADE/
    );
    expect(sql).toMatch(
      /"environment_slug_aliases_project_id_fkey" FOREIGN KEY \("project_id"\) REFERENCES "projects"\("id"\) ON DELETE CASCADE/
    );
    expect(sql).toContain(
      'CREATE INDEX "environment_slug_aliases_environment_idx" ON "environment_slug_aliases" ("environment_id")'
    );
  });
});

// Materialised names (deploy dir, database name, tunnel label, Mailpit,
// archives) are stored when the environment is created; the code that acts
// on servers must never re-derive one from the current slug, or a rename
// would move it. Each of these trees reads stored values only.
describe("runtime code never derives a name from the current slug", () => {
  const runtime = [
    "lib/jobs",
    "lib/deploy",
    "lib/provisioning",
    "lib/tunnels",
    "lib/domains",
    "lib/mailpit",
    "lib/cloudflare",
    "lib/instance-backup",
    "lib/steps",
    "lib/teardown/archive.ts",
    "lib/variables/managed-env.ts",
    "lib/variables/env-file.ts",
  ];

  it("reads no environments.slug and no {envSlug} placeholder", async () => {
    const { globSync } = await import("node:fs");
    const files = runtime.flatMap((p) =>
      p.endsWith(".ts") ? [p] : globSync(`${p}/**/*.ts`)
    );
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/environments\.slug/);
      expect(text, file).not.toMatch(/resolvePlaceholders|envSlug/);
    }
  });
});

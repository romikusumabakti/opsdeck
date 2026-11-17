import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// The assistant runs on whichever provider the admin configures, so no
// tracked file names one vendor outside the provider module. The exceptions
// are stored identifiers that cannot change (expand-only schema) and the
// provider picker's label.

const EXCLUDED = [
  "lib/assistant/providers.ts",
  "tests/assistant-providers.test.ts",
  "tests/no-vendor-names.test.ts",
  "drizzle/",
  // Checks the migration in drizzle/ that moved the old vendor key column.
  "tests/assistant-migration-scratch.test.ts",
  "bun.lock",
];

const LOCALES = ["ar", "en", "es", "id", "zh"];

/** `path:line` (trimmed), the only matches allowed outside EXCLUDED. */
const ALLOWED = [
  ...LOCALES.map(
    (locale) =>
      `messages/${locale}.json:"providerAnthropic": "Anthropic (Claude)",`
  ),
  // The provider package the provider module builds models with (its version
  // is dropped below).
  'package.json:"@ai-sdk/anthropic"',
  // The old key column (unused, kept until a release drops it) and the stored
  // provider id.
  'lib/db/schema.ts:legacyApiKey: text("anthropic_api_key"),',
  'lib/db/schema.ts:enum: ["anthropic", "openai", "google", "openai-compatible"],',
  // A source line, not a template.
  "lib/db/schema.ts:sql`$" +
    "{t.assistantProvider} in ('anthropic', 'openai', 'google', 'openai-compatible')`",
  // A coding agent's local state directory, kept out of git and the image.
  ".dockerignore:.claude",
  ".gitignore:.claude/settings.local.json",
  ".gitignore:.claude/scheduled_tasks.lock",
].sort();

function vendorMatches(): string[] {
  let out = "";
  try {
    out = execFileSync(
      "git",
      [
        "grep",
        "-niIE",
        "anthropic|claude",
        "--",
        ".",
        ...EXCLUDED.map((path) => `:(exclude)${path}`),
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
    );
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status !== 1) throw error;
  }
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [path, , ...rest] = line.split(":");
      const text = rest.join(":").trim();
      return path === "package.json"
        ? `${path}:${text.replace(/^("[^"]+"):.*$/, "$1")}`
        : `${path}:${text}`;
    })
    .sort();
}

describe("vendor names", () => {
  it("appear only in the provider module and the allowed lines", () => {
    expect(vendorMatches()).toEqual(ALLOWED);
  });
});

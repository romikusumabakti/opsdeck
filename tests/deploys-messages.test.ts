import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/locales";

type Messages = Record<string, unknown>;

function messages(locale: string): Messages {
  return JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));
}

// Every leaf of a namespace as "a.b.c" → value, so nested groups are compared
// key by key rather than only at the top level.
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

function at(m: Messages, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      m
    );
}

// Keys outside the `deploys` namespace that the deploy feature adds.
const SHARED_KEYS = [
  "nav.deploys",
  "breadcrumbs.deploys",
  "history.kindDeploy",
  "homePage.kind.deploy",
];

describe("deploys messages", () => {
  const en = leaves(messages("en").deploys);

  it("en defines the deploys namespace", () => {
    expect(messages("en").deploys).toBeTypeOf("object");
    expect(en.size).toBeGreaterThan(0);
  });

  for (const locale of locales) {
    it(`${locale} has the same deploys keys as en, all non-empty`, () => {
      const m = messages(locale);
      const own = leaves(m.deploys);
      expect([...own.keys()].sort()).toEqual([...en.keys()].sort());
      for (const [key, value] of own) {
        expect(typeof value, key).toBe("string");
        expect(String(value).trim().length, key).toBeGreaterThan(0);
      }
      for (const key of SHARED_KEYS) {
        expect(String(at(m, key) ?? "").trim().length, key).toBeGreaterThan(0);
      }
    });
  }
});

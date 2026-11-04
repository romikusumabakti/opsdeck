import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REGISTRATION_ISSUES, registerAppSchema } from "@/lib/ci/registration";
import { ISSUE_KEYS, issueMessage } from "@/lib/ci/registration-issues";

const CONN = "0197f3a0-1b2c-7def-8000-0123456789c1";

const SPEC = {
  branches: ["main"],
  images: [{ name: "hris-backend", dockerfile: "Dockerfile", context: "." }],
  bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
};

function component(extra: Record<string, unknown> = {}) {
  return {
    componentKey: "hris",
    ciConnectionId: CONN,
    forgeRemoteId: "{a}",
    bundleImage: "hris-deploy",
    pipelineMode: "generated",
    buildSpec: SPEC,
    ...extra,
  };
}

function app(components: unknown[]) {
  return { appKey: "hris", name: "HRIS", components };
}

/** The mapped issues of an input, as "path → key". */
function mapped(input: unknown): Record<string, string> {
  const result = registerAppSchema.safeParse(input);
  if (result.success) return {};
  return Object.fromEntries(
    result.error.issues.map((issue) => [
      issue.path.join("."),
      issueMessage(issue).key,
    ])
  );
}

// One input per custom issue the registration schema raises itself.
const CUSTOM_CASES: Record<(typeof REGISTRATION_ISSUES)[number], unknown> = {
  bundleImageMismatch: app([component({ bundleImage: "other-deploy" })]),
  buildSpecRequired: app([component({ buildSpec: undefined })]),
  buildSpecNotAllowed: app([component({ pipelineMode: "custom" })]),
  imageIsBundle: app([
    component({
      buildSpec: {
        ...SPEC,
        images: [
          { name: "hris-deploy", dockerfile: "Dockerfile", context: "." },
        ],
      },
    }),
  ]),
  duplicateComponentKey: app([
    component(),
    component({ forgeRemoteId: "{b}" }),
  ]),
  duplicateRepo: app([
    component(),
    component({ componentKey: "hris-two", bundleImage: "hris-two-deploy" }),
  ]),
};

describe("registration issue mapping", () => {
  it("has a case for every custom issue the schema raises", () => {
    expect(Object.keys(CUSTOM_CASES).sort()).toEqual(
      [...REGISTRATION_ISSUES].sort()
    );
  });

  for (const [key, input] of Object.entries(CUSTOM_CASES)) {
    it(`maps ${key} to its own message key`, () => {
      expect(Object.values(mapped(input))).toContain(key);
    });
  }

  it("passes the bundle name as a value", () => {
    const result = registerAppSchema.safeParse(
      CUSTOM_CASES.bundleImageMismatch
    );
    const issue = result.error?.issues[0];
    expect(issue && issueMessage(issue)).toEqual({
      key: "bundleImageMismatch",
      values: { bundle: "hris-deploy" },
    });
  });

  it("maps the shared schemas' issues to specific keys", () => {
    const issues = mapped(
      app([
        component({
          componentKey: "Bad Key",
          buildSpec: {
            branches: ["a..b"],
            tagShaLength: 3,
            images: [
              { name: "x", dockerfile: "../Dockerfile", context: "/abs" },
              { name: "x", dockerfile: "Dockerfile", context: "." },
            ],
            bundleFiles: [
              { from: "a", to: "same" },
              { from: "b", to: "same" },
            ],
            checks: [
              { name: "build", image: "node:24", dir: ".", commands: ["x"] },
              { name: "Bad", image: " bad", dir: ".", commands: [] },
            ],
          },
        }),
      ])
    );
    const p = "components.0.buildSpec";
    expect(issues).toMatchObject({
      "components.0.componentKey": "invalidKey",
      [`${p}.branches.0`]: "invalidBranch",
      [`${p}.tagShaLength`]: "tooSmall",
      [`${p}.images.0.dockerfile`]: "invalidPath",
      [`${p}.images.0.context`]: "invalidPath",
      [`${p}.images`]: "duplicateImage",
      [`${p}.bundleFiles`]: "duplicateBundleTarget",
      [`${p}.checks.0.name`]: "reservedStepName",
      [`${p}.checks.1.name`]: "invalidStepName",
      [`${p}.checks.1.image`]: "invalidImage",
      [`${p}.checks.1.commands`]: "atLeastOne",
    });
    expect(Object.values(issues)).not.toContain("invalid");
  });

  it("maps blanks and non-numbers", () => {
    const issues = mapped({
      appKey: "",
      name: "",
      components: [
        component({
          forgeRemoteId: "",
          buildSpec: { ...SPEC, timeoutMinutes: Number.NaN },
        }),
      ],
    });
    expect(issues).toMatchObject({
      name: "required",
      appKey: "invalidKey",
      "components.0.forgeRemoteId": "required",
      "components.0.buildSpec.timeoutMinutes": "notANumber",
    });
    expect(mapped({ appKey: "a", name: "A", components: [] })).toEqual({
      components: "atLeastOne",
    });
  });

  for (const locale of ["en", "id"]) {
    it(`${locale} translates every issue key`, () => {
      const messages = JSON.parse(
        readFileSync(`messages/${locale}.json`, "utf8")
      );
      for (const key of ISSUE_KEYS) {
        expect(messages.appForm.issues[key], key).toBeTypeOf("string");
      }
    });
  }

  it("en and id differ for every issue key", () => {
    const en = JSON.parse(readFileSync("messages/en.json", "utf8"));
    const id = JSON.parse(readFileSync("messages/id.json", "utf8"));
    for (const key of ISSUE_KEYS) {
      expect(id.appForm.issues[key], key).not.toBe(en.appForm.issues[key]);
    }
  });
});

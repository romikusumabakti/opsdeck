import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMap, isScalar, isSeq, parseDocument, Scalar } from "yaml";
import { type BuildSpec, buildSpecSchema } from "@/lib/ci/build-spec";
import { generateWoodpeckerPipeline } from "@/lib/ci/pipeline";

// Hand-written from the real pipelines (dplk-membership sucor/development and
// hris main), adapted to SPEC below — never produced by the generator. If the
// generator drifts from what those repos run, this file is the alarm.
const FIXTURE = await readFile(
  new URL("./fixtures/pipeline-two-images.yaml", import.meta.url),
  "utf8"
);

const REGISTRY = "192.168.56.113:5000";

const SPEC: BuildSpec = buildSpecSchema.parse({
  branches: ["main"],
  tagShaLength: 9,
  images: [
    {
      name: "dplk-membership-backend",
      dockerfile: "backend/Dockerfile",
      context: "backend",
    },
    {
      name: "dplk-membership-frontend",
      dockerfile: "frontend/Dockerfile",
      context: "frontend",
    },
  ],
  bundleFiles: [
    { from: "compose.yaml", to: "compose.yaml" },
    { from: "deploy/migrate/init_db.sql", to: "migrate/init_db.sql" },
  ],
  checks: [
    {
      name: "backend-tests",
      image: "eclipse-temurin:25-jdk",
      dir: "backend",
      commands: ["chmod +x gradlew", "./gradlew --no-daemon test"],
    },
  ],
});

const render = (spec: BuildSpec = SPEC, key = "dplk-membership") =>
  generateWoodpeckerPipeline(key, spec, { registry: REGISTRY });

function allCommands(source: string): string[] {
  const doc = parseDocument(source);
  const steps = doc.get("steps");
  if (!isSeq(steps)) throw new Error("steps is not a list");
  return steps.items.flatMap((step) => {
    if (!isMap(step)) throw new Error("step is not a map");
    const commands = step.get("commands");
    if (!isSeq(commands)) throw new Error("commands is not a list");
    return commands.items.map((item) => {
      if (!isScalar(item) || typeof item.value !== "string") {
        throw new Error(`command is not a string: ${String(item)}`);
      }
      return item.value;
    });
  });
}

describe("generateWoodpeckerPipeline", () => {
  it("renders byte-equal to the hand-written fixture", () => {
    expect(render()).toBe(FIXTURE);
  });

  it("parses as YAML with the expected structure and string commands", () => {
    const doc = parseDocument(render());
    expect(doc.errors).toEqual([]);
    expect(doc.toJS().when).toEqual([
      { event: ["push", "manual"], branch: ["main"] },
    ]);
    const steps = doc.toJS().steps as { name: string }[];
    expect(steps.map((s) => s.name)).toEqual([
      "backend-tests",
      "build",
      "notify-panel",
    ]);
    for (const command of allCommands(render())) {
      expect(typeof command).toBe("string");
    }
  });

  it("emits every multi-line command as a literal block scalar", () => {
    const doc = parseDocument(render());
    const steps = doc.get("steps");
    if (!isSeq(steps)) throw new Error("steps is not a list");
    let blocks = 0;
    for (const step of steps.items) {
      if (!isMap(step)) throw new Error("step is not a map");
      const commands = step.get("commands");
      if (!isSeq(commands)) throw new Error("commands is not a list");
      for (const item of commands.items) {
        if (!isScalar(item)) throw new Error("command is not a scalar");
        if (String(item.value).includes("\n")) {
          expect(item.type).toBe(Scalar.BLOCK_LITERAL);
          blocks += 1;
        }
      }
    }
    expect(blocks).toBeGreaterThan(0);
  });

  it("keeps every `cd` inside a subshell", () => {
    const spec = buildSpecSchema.parse({
      ...SPEC,
      checks: [
        ...SPEC.checks,
        {
          name: "frontend-build",
          image: "node:24-alpine",
          dir: "frontend",
          commands: ["npm ci", "cd dist && ls"],
        },
      ],
    });
    for (const command of allCommands(render(spec))) {
      let depth = 0;
      for (const raw of command.split("\n")) {
        const line = raw.trim();
        if (line === ")") depth -= 1;
        if (/(^|[\s;&|])cd /.test(line)) expect(depth).toBeGreaterThan(0);
        if (line === "(") depth += 1;
      }
      expect(depth).toBe(0);
    }
  });

  it("doubles every `$` before `{`, including in check commands", () => {
    const spec = buildSpecSchema.parse({
      ...SPEC,
      checks: [
        {
          name: "env-check",
          image: "alpine:3",
          dir: ".",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
          commands: ['echo "${CI_COMMIT_SHA}" $HOME'],
        },
      ],
    });
    const out = render(spec);
    const runs = out.match(/\$+\{/g) ?? [];
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect((run.length - 1) % 2).toBe(0);
    // A bare `$VAR` is substituted by Woodpecker too, so it is escaped as well.
    expect(out).toContain('echo "$${CI_COMMIT_SHA}" $$HOME');
  });

  it("depends on nothing when there are no checks", () => {
    const { checks: _checks, ...rest } = SPEC;
    const steps = parseDocument(render(buildSpecSchema.parse(rest))).toJS()
      .steps as { name: string; depends_on?: string[] }[];
    expect(steps.map((s) => [s.name, s.depends_on])).toEqual([
      ["build", undefined],
      ["notify-panel", undefined],
    ]);
  });

  it("makes the build wait for every check", () => {
    const spec = buildSpecSchema.parse({
      ...SPEC,
      checks: [
        ...SPEC.checks,
        { name: "lint", image: "alpine:3", dir: ".", commands: ["true"] },
      ],
    });
    const steps = parseDocument(render(spec)).toJS().steps as {
      name: string;
      depends_on?: string[];
    }[];
    expect(steps.find((s) => s.name === "build")?.depends_on).toEqual([
      "backend-tests",
      "lint",
    ]);
  });

  it("cuts the sha to the default 7 characters", () => {
    const spec = buildSpecSchema.parse({ ...SPEC, tagShaLength: undefined });
    expect(render(spec)).toContain("cut -c1-7)");
  });

  it("quotes nothing a YAML reader could misread in branch lists", () => {
    const spec = buildSpecSchema.parse({
      ...SPEC,
      branches: ["sucor/development", "release/1.0"],
    });
    expect(parseDocument(render(spec)).toJS().when[0].branch).toEqual([
      "sucor/development",
      "release/1.0",
    ]);
  });

  it("rejects an invalid component key", () => {
    expect(() => render(SPEC, 'x"; rm -rf /')).toThrow();
  });

  it("re-validates the spec it is given", () => {
    const bad = { ...SPEC, images: [] } as unknown as BuildSpec;
    expect(() => render(bad)).toThrow();
  });

  describe("registry", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("defaults to DEPLOY_REGISTRY", () => {
      vi.stubEnv("DEPLOY_REGISTRY", "registry.example.test:5000");
      expect(generateWoodpeckerPipeline("hris", SPEC)).toContain(
        "REGISTRY: registry.example.test:5000"
      );
    });

    it("fails without a registry", () => {
      vi.stubEnv("DEPLOY_REGISTRY", "");
      expect(() => generateWoodpeckerPipeline("hris", SPEC)).toThrow(
        /DEPLOY_REGISTRY/
      );
    });
  });
});

describe("buildSpecSchema", () => {
  const base = {
    branches: ["main"],
    images: [{ name: "app", dockerfile: "Dockerfile", context: "." }],
    bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
  };

  it("applies defaults", () => {
    expect(buildSpecSchema.parse(base)).toMatchObject({
      tagShaLength: 7,
      checks: [],
      timeoutMinutes: 60,
    });
  });

  it.each([
    ["to with ..", { bundleFiles: [{ from: "a", to: "../etc/passwd" }] }],
    ["to with inner ..", { bundleFiles: [{ from: "a", to: "x/../../y" }] }],
    ["absolute to", { bundleFiles: [{ from: "a", to: "/etc/passwd" }] }],
    ["from with ..", { bundleFiles: [{ from: "../secret", to: "a" }] }],
    ["from with a space", { bundleFiles: [{ from: "a b", to: "a" }] }],
    [
      "duplicate to",
      {
        bundleFiles: [
          { from: "a", to: "x" },
          { from: "b", to: "x" },
        ],
      },
    ],
    [
      "context with a shell metacharacter",
      { images: [{ name: "app", dockerfile: "Dockerfile", context: ".;id" }] },
    ],
    [
      "uppercase image name",
      { images: [{ name: "App", dockerfile: "Dockerfile", context: "." }] },
    ],
    ["branch with a quote", { branches: ['main"'] }],
    ["no branches", { branches: [] }],
    ["sha length below 7", { tagShaLength: 6 }],
    ["timeout above 180", { timeoutMinutes: 181 }],
    [
      "check named like a generated step",
      {
        checks: [
          { name: "build", image: "alpine:3", dir: ".", commands: ["true"] },
        ],
      },
    ],
    [
      "duplicate check names",
      {
        checks: [
          { name: "a", image: "alpine:3", dir: ".", commands: ["true"] },
          { name: "a", image: "alpine:3", dir: ".", commands: ["true"] },
        ],
      },
    ],
    [
      "check dir with ..",
      {
        checks: [
          { name: "a", image: "alpine:3", dir: "..", commands: ["true"] },
        ],
      },
    ],
    [
      "check image with a space",
      {
        checks: [
          { name: "a", image: "alpine 3", dir: ".", commands: ["true"] },
        ],
      },
    ],
  ])("rejects %s", (_label, override) => {
    expect(buildSpecSchema.safeParse({ ...base, ...override }).success).toBe(
      false
    );
  });
});

import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMap, isScalar, isSeq, parseDocument, Scalar } from "yaml";
import { type BuildSpec, buildSpecSchema } from "@/lib/ci/build-spec";
import { generateWoodpeckerPipeline } from "@/lib/ci/pipeline";

// Hand-written from the real pipelines (dplk-membership kestrel/development and
// hris main), adapted to SPEC below — never produced by the generator. If the
// generator drifts from what those repos run, this file is the alarm.
const FIXTURE = await readFile(
  new URL("./fixtures/pipeline-two-images.yaml", import.meta.url),
  "utf8"
);

const readFixture = (name: string) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const REGISTRY = "192.168.10.113:5000";

const JAR_SPEC: BuildSpec = buildSpecSchema.parse({
  branches: ["kestrel/development"],
  artifact: { kind: "jar", path: "build/libs/dss-service-0.1.0.jar" },
  checks: [
    {
      name: "gradle-build",
      image: "docker.io/library/eclipse-temurin:8-jdk",
      dir: ".",
      commands: ["./gradlew build -x test"],
    },
  ],
});

const STATIC_SPEC: BuildSpec = buildSpecSchema.parse({
  branches: ["main"],
  artifact: { kind: "static", path: "dist" },
  checks: [
    {
      name: "vite-build",
      image: "docker.io/oven/bun:1",
      dir: ".",
      commands: ["bun install --frozen-lockfile", "bun run build"],
    },
  ],
});

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
      branches: ["kestrel/development", "release/1.0"],
    });
    expect(parseDocument(render(spec)).toJS().when[0].branch).toEqual([
      "kestrel/development",
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

  describe("artifact", () => {
    it("renders the artifact jar pipeline byte-equal to the fixture", async () => {
      expect(render(JAR_SPEC, "core")).toBe(
        await readFixture("pipeline-artifact-jar.yaml")
      );
    });

    it("renders the artifact static pipeline byte-equal to the fixture", async () => {
      expect(render(STATIC_SPEC, "backoffice")).toBe(
        await readFixture("pipeline-artifact-static.yaml")
      );
    });

    it("triggers on any branch", () => {
      const doc = parseDocument(render(JAR_SPEC, "core"));
      expect(doc.toJS().when).toEqual([{ event: ["push", "manual"] }]);
    });

    it("uses the given notify secret name", () => {
      const yaml = generateWoodpeckerPipeline("core", JAR_SPEC, {
        registry: REGISTRY,
        notifySecretName: "opsdeck_notify_core",
      });
      expect(yaml).toContain("from_secret: opsdeck_notify_core");
      expect(yaml).not.toContain("from_secret: opsdeck_notify\n");
    });

    it("passes a check's environment, plain values escaped and secrets by reference", () => {
      const spec = {
        ...STATIC_SPEC,
        checks: STATIC_SPEC.checks.map((check) => ({
          ...check,
          environment: {
            VUE_APP_API_URL: "/api",
            VUE_APP_TITLE: "DPLK $TMLI",
            VUE_APP_STATIC_TOKEN: { fromSecret: "legacy_portal_static_token" },
          },
        })),
      } as BuildSpec;
      const doc = parseDocument(render(spec, "backoffice"));
      const step = (
        doc.toJS().steps as { name: string; environment?: unknown }[]
      )[0];
      expect(step?.environment).toEqual({
        VUE_APP_API_URL: "/api",
        VUE_APP_TITLE: "DPLK $$TMLI",
        VUE_APP_STATIC_TOKEN: { from_secret: "legacy_portal_static_token" },
      });
    });

    it("leaves a check without environment unchanged", () => {
      const doc = parseDocument(render(STATIC_SPEC, "backoffice"));
      const step = (doc.toJS().steps as { environment?: unknown }[])[0];
      expect(step?.environment).toBeUndefined();
    });

    it("defaults the notify secret name", () => {
      expect(render(JAR_SPEC, "core")).toContain(
        "from_secret: opsdeck_notify\n"
      );
    });
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

describe("buildSpecSchema environment", () => {
  const spec = (environment: unknown) => ({
    branches: [],
    artifact: { kind: "static", path: "dist" },
    checks: [
      {
        name: "build-it",
        image: "node:24",
        dir: ".",
        commands: ["npm ci"],
        environment,
      },
    ],
  });

  it("accepts plain values and secret references", () => {
    expect(
      buildSpecSchema.safeParse(
        spec({ VUE_APP_API_URL: "/api", TOKEN: { fromSecret: "legacy_token" } })
      ).success
    ).toBe(true);
  });

  it.each([
    ["a lowercase name", { api_url: "/api" }],
    ["a name with a dash", { "API-URL": "/api" }],
    ["a multi-line value", { API_URL: "a\nb" }],
    ["an invalid secret name", { TOKEN: { fromSecret: "Bad-Name" } }],
    ["the notify secret", { TOKEN: { fromSecret: "opsdeck_notify" } }],
    [
      "a suffixed notify secret",
      { TOKEN: { fromSecret: "opsdeck_notify_core" } },
    ],
  ])("rejects %s", (_label, environment) => {
    expect(buildSpecSchema.safeParse(spec(environment)).success).toBe(false);
  });
});

describe("buildSpecSchema", () => {
  const base = {
    branches: ["main"],
    images: [{ name: "app", dockerfile: "Dockerfile", context: "." }],
    bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
  };

  describe("artifact", () => {
    const check = {
      name: "build-it",
      image: "alpine:3",
      dir: ".",
      commands: ["true"],
    };
    const artifact = { kind: "jar", path: "build/app.jar" };

    it("accepts an artifact with checks and no branches, images or files", () => {
      expect(
        buildSpecSchema.safeParse({ artifact, checks: [check], branches: [] })
          .success
      ).toBe(true);
    });

    it("artifact spec with images is rejected", () => {
      expect(
        buildSpecSchema.safeParse({
          artifact,
          checks: [check],
          branches: ["main"],
          images: base.images,
        }).success
      ).toBe(false);
    });

    it("artifact spec with bundle files is rejected", () => {
      expect(
        buildSpecSchema.safeParse({
          artifact,
          checks: [check],
          branches: ["main"],
          bundleFiles: base.bundleFiles,
        }).success
      ).toBe(false);
    });

    it("artifact spec without checks is rejected", () => {
      expect(
        buildSpecSchema.safeParse({ artifact, branches: ["main"] }).success
      ).toBe(false);
    });

    it("rejects an artifact path with ..", () => {
      expect(
        buildSpecSchema.safeParse({
          artifact: { kind: "static", path: "../dist" },
          checks: [check],
        }).success
      ).toBe(false);
    });

    it("still requires images and bundle files without an artifact", () => {
      expect(buildSpecSchema.safeParse({ branches: ["main"] }).success).toBe(
        false
      );
    });
  });

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

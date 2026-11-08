import { describe, expect, it } from "vitest";
import { buildSpecSchema } from "@/lib/ci/build-spec";
import {
  generateWoodpeckerPipeline,
  PANEL_PIPELINE_MARKER,
} from "@/lib/ci/pipeline";
import { detectRepo, suggestedBuildSpec } from "@/lib/setup/detect";
import { firstUserNetwork } from "@/lib/setup/network";

const HRIS_COMPOSE = `
services:
  hris-db:
    image: postgres:18
  hris-backend:
    build: ./backend
    depends_on: [hris-db]
  hris-frontend:
    build:
      context: ./frontend
    ports:
      - "127.0.0.1:8091:80"
  hris-migrate:
    build: ./backend
    profiles: [tools]
`;

describe("detectRepo", () => {
  it("detects the HRIS-like layout", () => {
    const out = detectRepo([
      { path: "compose.yaml", content: HRIS_COMPOSE },
      { path: "backend/Dockerfile" },
      { path: "frontend/Dockerfile" },
      { path: "README.md" },
    ]);
    expect(out.composeFile).toBe("compose.yaml");
    expect(out.services.map((s) => s.name)).toEqual([
      "hris-db",
      "hris-backend",
      "hris-frontend",
    ]);
    expect(out.services[2]).toMatchObject({
      build: "./frontend",
      ports: [{ host: "8091", container: 80 }],
    });
    expect(out.entryService).toBe("hris-frontend");
    expect(out.entryContainerPort).toBe(80);
    expect(out.dockerfiles).toEqual([
      "backend/Dockerfile",
      "frontend/Dockerfile",
    ]);
    expect(out.issues).toEqual([]);
  });

  it("reports no_compose", () => {
    const out = detectRepo([{ path: "Dockerfile" }]);
    expect(out.issues).toEqual(["no_compose"]);
    expect(out.composeFile).toBeNull();
    expect(out.dockerfiles).toEqual(["Dockerfile"]);
  });

  it("reports no_dockerfile alongside a compose file", () => {
    const out = detectRepo([
      { path: "compose.yaml", content: "services:\n  a:\n    image: x\n" },
    ]);
    expect(out.issues).toEqual(["no_dockerfile"]);
  });

  it("reports broken YAML without throwing", () => {
    const out = detectRepo([
      { path: "compose.yaml", content: "services: [unclosed\n  - : :" },
      { path: "Dockerfile" },
    ]);
    expect(out.issues).toEqual(["compose_parse_error"]);
    expect(out.composeFile).toBe("compose.yaml");
    expect(out.services).toEqual([]);
  });

  it("treats a document without services as a parse error", () => {
    const out = detectRepo([
      { path: "compose.yaml", content: "name: x\n" },
      { path: "Dockerfile" },
    ]);
    expect(out.issues).toEqual(["compose_parse_error"]);
  });

  it("prefers compose.yaml over the older names", () => {
    const out = detectRepo([
      { path: "docker-compose.yml", content: "services: {a: {image: x}}" },
      { path: "compose.yaml", content: "services: {b: {image: y}}" },
    ]);
    expect(out.services.map((s) => s.name)).toEqual(["b"]);
  });

  it("falls back to frontend, web or app when nothing publishes a port", () => {
    const out = detectRepo([
      {
        path: "compose.yaml",
        content: "services:\n  api:\n    image: a\n  web:\n    image: b\n",
      },
    ]);
    expect(out.entryService).toBe("web");
    expect(out.entryContainerPort).toBeNull();
  });

  it("has no entry service when nothing matches", () => {
    const out = detectRepo([
      { path: "compose.yaml", content: "services:\n  api:\n    image: a\n" },
    ]);
    expect(out.entryService).toBeNull();
  });

  it("parses the port forms", () => {
    const out = detectRepo([
      {
        path: "compose.yaml",
        content: `
services:
  s:
    image: x
    ports:
      - 80
      - "8080:80/tcp"
      - "\${PORT:-9000}:3000"
      - "8000-8010:8000-8010"
      - target: 443
        published: 8443
`,
      },
    ]);
    expect(out.services[0]?.ports).toEqual([
      { host: null, container: 80 },
      { host: "8080", container: 80 },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose variable reference
      { host: "${PORT:-9000}", container: 3000 },
      { host: "8443", container: 443 },
    ]);
  });

  it("finds Dockerfiles named *.Dockerfile up to depth 2 only", () => {
    const out = detectRepo([
      { path: "api.Dockerfile" },
      { path: "docker/Dockerfile" },
      { path: "a/b/Dockerfile" },
      { path: "Dockerfile.dev" },
    ]);
    expect(out.dockerfiles).toEqual(["api.Dockerfile", "docker/Dockerfile"]);
  });
});

describe("firstUserNetwork", () => {
  it("skips bridge, host and none", () => {
    expect(firstUserNetwork('{"bridge":{},"app_net":{},"other":{}}')).toBe(
      "app_net"
    );
  });

  it("is null with only default networks, bad JSON or a non-object", () => {
    expect(firstUserNetwork('{"bridge":{}}')).toBeNull();
    expect(firstUserNetwork("not json")).toBeNull();
    expect(firstUserNetwork("[]")).toBeNull();
    expect(firstUserNetwork("null")).toBeNull();
    expect(firstUserNetwork("")).toBeNull();
  });

  it("ignores a name Docker would not accept", () => {
    expect(firstUserNetwork('{"bad name;":{},"good":{}}')).toBe("good");
  });
});

describe("compose names", () => {
  it("reads compose name and container_name", () => {
    const out = detectRepo([
      {
        path: "compose.yaml",
        content:
          "name: hris\nservices:\n  web:\n    image: x\n    container_name: hris-web\n  db:\n    image: y\n",
      },
    ]);
    expect(out.projectName).toBe("hris");
    expect(out.services.map((s) => s.containerName)).toEqual([
      "hris-web",
      null,
    ]);
  });
});

describe("pipeline detection", () => {
  it("recognises a Panel-generated pipeline", () => {
    const out = detectRepo([
      {
        path: ".woodpecker.yaml",
        content:
          "# Generated by DSS Panel for panel-canary-2 — edit the build spec in the Panel, not this file.\nwhen: []\n",
      },
    ]);
    expect(out.pipeline).toEqual({
      kind: "panel",
      componentKey: "panel-canary-2",
    });
  });

  it("matches what the generator writes", () => {
    const spec = buildSpecSchema.parse({
      branches: ["main"],
      images: [{ name: "demo", dockerfile: "Dockerfile", context: "." }],
      bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
    });
    const yaml = generateWoodpeckerPipeline("demo", spec, {
      registry: "192.168.56.113:5000",
    });
    expect(PANEL_PIPELINE_MARKER.exec(yaml)?.[1]).toBe("demo");
  });

  it("custom pipeline that notifies", () => {
    const notifying = detectRepo([
      {
        path: ".woodpecker/build.yaml",
        content:
          "steps:\n  - environment:\n      S: { from_secret: opsdeck_notify }\n",
      },
    ]);
    expect(notifying.pipeline).toEqual({ kind: "custom", notifiesPanel: true });
    const silent = detectRepo([
      { path: ".woodpecker.yml", content: "steps: []\n" },
    ]);
    expect(silent.pipeline).toEqual({ kind: "custom", notifiesPanel: false });
  });

  it("is none without a pipeline file", () => {
    expect(detectRepo([{ path: "Dockerfile" }]).pipeline).toEqual({
      kind: "none",
    });
  });
});

describe("suggestedBuildSpec", () => {
  it("suggests a build spec", () => {
    const out = detectRepo([
      { path: "Dockerfile" },
      { path: "compose.yaml", content: "services:\n  web:\n    image: x\n" },
      { path: "compose.override.yaml" },
    ]);
    expect(suggestedBuildSpec(out, "demo", "main")).toMatchObject({
      images: [{ name: "demo", dockerfile: "Dockerfile", context: "." }],
      bundleFiles: [
        { from: "compose.yaml", to: "compose.yaml" },
        { from: "compose.override.yaml", to: "compose.override.yaml" },
      ],
      branches: ["main"],
      checks: [],
      timeoutMinutes: 60,
    });
  });

  it("adds an image per sub-directory Dockerfile", () => {
    const out = detectRepo([
      { path: "Dockerfile" },
      { path: "api/Dockerfile" },
      { path: "compose.yaml", content: "services:\n  web:\n    image: x\n" },
    ]);
    expect(suggestedBuildSpec(out, "demo", "main")?.images).toEqual([
      { name: "demo", dockerfile: "Dockerfile", context: "." },
      { name: "demo-api", dockerfile: "api/Dockerfile", context: "api" },
    ]);
  });

  it("never emits the bundle image name", () => {
    const out = detectRepo([
      { path: "Dockerfile" },
      { path: "deploy/Dockerfile" },
      { path: "compose.yaml", content: "services:\n  web:\n    image: x\n" },
    ]);
    expect(suggestedBuildSpec(out, "demo", "main")?.images).toEqual([
      { name: "demo", dockerfile: "Dockerfile", context: "." },
    ]);
  });

  it("keeps valid images when a directory name is invalid", () => {
    const out = detectRepo([
      { path: "Dockerfile" },
      { path: "Api/Dockerfile" },
      { path: "my dir/Dockerfile" },
      { path: "compose.yaml", content: "services:\n  web:\n    image: x\n" },
    ]);
    expect(suggestedBuildSpec(out, "demo", "main")?.images).toEqual([
      { name: "demo", dockerfile: "Dockerfile", context: "." },
      { name: "demo-api", dockerfile: "Api/Dockerfile", context: "Api" },
    ]);
  });

  it("skips a directory the context rule rejects", () => {
    const out = detectRepo([
      { path: "Dockerfile" },
      { path: "-x/Dockerfile" },
      { path: "compose.yaml", content: "services:\n  web:\n    image: x\n" },
    ]);
    expect(suggestedBuildSpec(out, "demo", "main")?.images).toEqual([
      { name: "demo", dockerfile: "Dockerfile", context: "." },
    ]);
  });

  it("keeps the first of two directories that lowercase to one name", () => {
    const out = detectRepo([
      { path: "Dockerfile" },
      { path: "Api/Dockerfile" },
      { path: "api/Dockerfile" },
      { path: "compose.yaml", content: "services:\n  web:\n    image: x\n" },
    ]);
    expect(suggestedBuildSpec(out, "demo", "main")?.images).toEqual([
      { name: "demo", dockerfile: "Dockerfile", context: "." },
      { name: "demo-api", dockerfile: "Api/Dockerfile", context: "Api" },
    ]);
  });

  it("is null without a Dockerfile or a compose file", () => {
    const compose = "services:\n  web:\n    image: x\n";
    expect(
      suggestedBuildSpec(
        detectRepo([{ path: "compose.yaml", content: compose }]),
        "demo",
        "main"
      )
    ).toBeNull();
    expect(
      suggestedBuildSpec(detectRepo([{ path: "Dockerfile" }]), "demo", "main")
    ).toBeNull();
  });
});

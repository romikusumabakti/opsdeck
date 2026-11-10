import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TARGET_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";
const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789b2";
const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789b3";
const DEPLOYMENT_ID = "0197f3a0-1b2c-7def-8000-0123456789b4";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789b5";
const TAG = "origin-kestrel-development-abc1234";

const jarTarget = {
  id: TARGET_ID,
  environmentId: ENV_ID,
  componentKey: "core-web-service",
  serverId: SERVER_ID,
  sourceBranch: "kestrel/development",
  autoDeploy: true,
  kind: "jar" as const,
  deployDir: "/opt/core",
  jarName: "core-web-service.jar",
  systemdUnit: "core",
  services: [],
  tagVariable: "IMAGE_TAG",
  preStartCommand: null,
  healthUrl: "http://127.0.0.1:8080/actuator/health",
  healthTimeoutSeconds: 180,
  // Ignored for artifact targets: no backup is taken.
  backupBeforeDeploy: true,
};

const staticTarget = {
  ...jarTarget,
  componentKey: "core-web-frontend",
  kind: "static" as const,
  deployDir: "/var/www/core",
  jarName: null,
  systemdUnit: null,
  healthUrl: null,
};

const repo = vi.hoisted(() => ({
  getTarget: vi.fn(),
  getDeployment: vi.fn(),
  claimDeployment: vi.fn(),
  finishDeployment: vi.fn(),
  heartbeatDeployment: vi.fn(),
  markScriptStarted: vi.fn(),
  failStaleRunningDeployments: vi.fn(),
  listTagVariablesInDeployDir: vi.fn(),
  listServicesInDeployDir: vi.fn(),
  deployDirSharedWithOtherEnvironment: vi.fn(),
  getRunActor: vi.fn(),
}));
vi.mock("@/lib/deploy/repository", () => repo);

const apps = vi.hoisted(() => ({ getComponent: vi.fn() }));
vi.mock("@/lib/apps", () => apps);

const ssh = vi.hoisted(() => ({
  executeRemoteCommand: vi.fn(),
  uploadRemoteContent: vi.fn(),
  pipeToRemoteCommand: vi.fn(),
}));
vi.mock("@/lib/ssh", () => ssh);

const registry = vi.hoisted(() => ({ openArtifactLayer: vi.fn() }));
vi.mock("@/lib/registry/artifact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/registry/artifact")>()),
  openArtifactLayer: registry.openArtifactLayer,
}));

const composeScript = vi.hoisted(() => ({ buildDeployScript: vi.fn() }));
vi.mock("@/lib/deploy/script", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deploy/script")>()),
  buildDeployScript: composeScript.buildDeployScript,
}));

const envFile = vi.hoisted(() => ({ renderEnvFile: vi.fn() }));
vi.mock("@/lib/variables/env-file", () => envFile);

const progress = vi.hoisted(() => ({
  createRun: vi.fn(),
  appendRunOutput: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
}));
vi.mock("@/lib/run-progress", () => progress);

const environments = vi.hoisted(() => ({ loadServerCredentials: vi.fn() }));
vi.mock("@/lib/environments", () => environments);

const queue = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/lib/queue", () => queue);

const processor = vi.hoisted(() => ({ handleCreateDatabaseBackup: vi.fn() }));
vi.mock("@/lib/jobs/processor", () => processor);

const variables = vi.hoisted(() => ({
  loadManagedEnvFileVariables: vi.fn(),
  loadSharedDatabaseNetwork: vi.fn(),
}));
vi.mock("@/lib/variables/managed-env", () => variables);

const { handleDeploy } = await import("@/lib/jobs/deploy");
const { ArtifactImageError } = await import("@/lib/registry/artifact");
const {
  artifactStagingDir,
  buildArtifactDeployScript,
  buildArtifactExtractCommand,
} = await import("@/lib/deploy/artifact-script");

const payload = { deploymentId: DEPLOYMENT_ID, runId: RUN_ID };
const credentials = {
  host: "10.0.0.7",
  username: "root",
  password: "pw",
  run: RUN_ID,
};
const JAR_STAGING = `/opt/core/.opsdeck-incoming-${DEPLOYMENT_ID}`;
const STATIC_STAGING = `/var/www/core.opsdeck-incoming-${DEPLOYMENT_ID}`;

let layerStream: ReadableStream<Uint8Array>;

function outputLines(): string[] {
  return progress.appendRunOutput.mock.calls.map((c) => c[1] as string);
}

function useTarget(target: typeof jarTarget | typeof staticTarget) {
  repo.getTarget.mockResolvedValue(target);
  apps.getComponent.mockResolvedValue({
    componentKey: target.componentKey,
    bundleImage: `${target.componentKey}-deploy`,
  });
}

function jarScript(): string {
  return buildArtifactDeployScript({
    kind: "jar",
    deployDir: jarTarget.deployDir,
    deploymentId: DEPLOYMENT_ID,
    jarName: jarTarget.jarName,
    systemdUnit: jarTarget.systemdUnit,
    healthUrl: jarTarget.healthUrl,
    healthTimeoutSeconds: jarTarget.healthTimeoutSeconds,
  });
}

function removeStagingCalls(staging: string) {
  return ssh.executeRemoteCommand.mock.calls.filter(
    (c) => c[1] === `rm -rf '${staging}'`
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEPLOY_REGISTRY", "192.168.10.113:5000");
  useTarget(jarTarget);
  repo.getDeployment.mockResolvedValue({
    id: DEPLOYMENT_ID,
    targetId: TARGET_ID,
    environmentId: ENV_ID,
    runId: RUN_ID,
    tag: TAG,
    trigger: "auto",
    status: "running",
  });
  repo.claimDeployment.mockResolvedValue("claimed");
  repo.finishDeployment.mockResolvedValue(true);
  repo.heartbeatDeployment.mockResolvedValue(true);
  repo.markScriptStarted.mockResolvedValue(undefined);
  repo.failStaleRunningDeployments.mockResolvedValue([]);
  environments.loadServerCredentials.mockResolvedValue({
    host: "10.0.0.7",
    username: "root",
    password: "pw",
  });
  layerStream = new ReadableStream<Uint8Array>();
  registry.openArtifactLayer.mockResolvedValue({
    size: 1234,
    digest: `sha256:${"a".repeat(64)}`,
    stream: layerStream,
  });
  ssh.pipeToRemoteCommand.mockResolvedValue({ stdout: "", stderr: "" });
  ssh.executeRemoteCommand.mockResolvedValue("Enabled core\nHEALTHY\n");
  variables.loadManagedEnvFileVariables.mockResolvedValue([
    { name: "DB_URL", value: "jdbc:postgresql://db/core" },
  ]);
  variables.loadSharedDatabaseNetwork.mockResolvedValue("db-net");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function silenceErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("handleDeploy for a jar target", () => {
  it("fetches the artifact, pipes it into the staging dir, then runs the jar script", async () => {
    await expect(handleDeploy(payload)).resolves.toEqual({
      status: "success",
    });

    expect(registry.openArtifactLayer).toHaveBeenCalledWith(
      "core-web-service-deploy",
      TAG
    );
    expect(artifactStagingDir("jar", "/opt/core", DEPLOYMENT_ID)).toBe(
      JAR_STAGING
    );
    expect(ssh.pipeToRemoteCommand).toHaveBeenCalledWith(
      credentials,
      buildArtifactExtractCommand(JAR_STAGING),
      layerStream,
      { timeoutMs: 10 * 60_000 }
    );
    expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
    expect(ssh.executeRemoteCommand).toHaveBeenCalledWith(
      credentials,
      jarScript(),
      20 * 60_000
    );

    // Extract, then markScriptStarted, then the script.
    const pipeOrder = ssh.pipeToRemoteCommand.mock.invocationCallOrder[0];
    const markOrder = repo.markScriptStarted.mock.invocationCallOrder[0];
    const execOrder = ssh.executeRemoteCommand.mock.invocationCallOrder[0];
    expect(pipeOrder).toBeLessThan(markOrder as number);
    expect(markOrder).toBeLessThan(execOrder as number);
    expect(repo.markScriptStarted).toHaveBeenCalledWith(DEPLOYMENT_ID);

    // None of the compose machinery runs.
    expect(composeScript.buildDeployScript).not.toHaveBeenCalled();
    expect(envFile.renderEnvFile).not.toHaveBeenCalled();
    expect(variables.loadManagedEnvFileVariables).not.toHaveBeenCalled();
    expect(variables.loadSharedDatabaseNetwork).not.toHaveBeenCalled();
    expect(ssh.uploadRemoteContent).not.toHaveBeenCalled();
    expect(processor.handleCreateDatabaseBackup).not.toHaveBeenCalled();
    expect(progress.createRun).not.toHaveBeenCalled();

    expect(outputLines()).toEqual([
      `Fetched core-web-service-deploy:${TAG} (1234 bytes)`,
      `Deploying core-web-service ${TAG} to /opt/core`,
      "Enabled core\nHEALTHY",
    ]);
    expect(repo.finishDeployment).toHaveBeenCalledWith(
      DEPLOYMENT_ID,
      "success"
    );
    expect(progress.completeRun).toHaveBeenCalledWith(RUN_ID);
  });

  it("an ArtifactImageError fails the deployment before markScriptStarted", async () => {
    const error = new ArtifactImageError("found 2 layers, expected 1");
    registry.openArtifactLayer.mockRejectedValue(error);

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(repo.markScriptStarted).not.toHaveBeenCalled();
    expect(ssh.pipeToRemoteCommand).not.toHaveBeenCalled();
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(repo.finishDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID, "failed");
    expect(outputLines().join("\n")).toContain(error.message);
    expect(progress.failRun).toHaveBeenCalledWith(RUN_ID, error.message);
  });

  it("a missing artifact or a registry auth error fails before markScriptStarted", async () => {
    for (const message of [
      `artifact core-web-service-deploy:${TAG} not found in the registry`,
      "registry authentication failed while reading manifest core-web-service-deploy:x (HTTP 401); check DEPLOY_REGISTRY_USERNAME and DEPLOY_REGISTRY_PASSWORD",
    ]) {
      vi.clearAllMocks();
      registry.openArtifactLayer.mockRejectedValue(new Error(message));

      await expect(handleDeploy(payload)).resolves.toEqual({
        status: "failed",
      });

      expect(repo.markScriptStarted).not.toHaveBeenCalled();
      expect(ssh.pipeToRemoteCommand).not.toHaveBeenCalled();
      expect(outputLines().join("\n")).toContain(message);
      expect(progress.failRun).toHaveBeenCalledWith(RUN_ID, message);
    }
  });

  it("a lost heartbeat before the fetch touches neither registry nor server", async () => {
    repo.heartbeatDeployment.mockResolvedValue(false);

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(registry.openArtifactLayer).not.toHaveBeenCalled();
    expect(ssh.pipeToRemoteCommand).not.toHaveBeenCalled();
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(repo.markScriptStarted).not.toHaveBeenCalled();
  });

  it("a failed extract fails the deployment and removes the staging dir", async () => {
    silenceErrors();
    ssh.pipeToRemoteCommand.mockRejectedValue(
      new Error("SSH Command Failed (exit 2): tar: Unexpected EOF")
    );
    ssh.executeRemoteCommand.mockResolvedValue("");

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(repo.markScriptStarted).not.toHaveBeenCalled();
    expect(removeStagingCalls(JAR_STAGING)).toHaveLength(1);
    expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
    expect(progress.failRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.stringContaining("tar: Unexpected EOF")
    );
  });

  it("a heartbeat lost during the extract removes the staging dir and never runs the script", async () => {
    repo.heartbeatDeployment
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    ssh.executeRemoteCommand.mockResolvedValue("");

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(repo.markScriptStarted).not.toHaveBeenCalled();
    expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
    expect(removeStagingCalls(JAR_STAGING)).toHaveLength(1);
  });

  it("a failing markScriptStarted removes the staging dir and never runs the script", async () => {
    repo.markScriptStarted.mockRejectedValue(new Error("db down"));
    ssh.executeRemoteCommand.mockResolvedValue("");

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
    expect(removeStagingCalls(JAR_STAGING)).toHaveLength(1);
    expect(progress.failRun).toHaveBeenCalledWith(RUN_ID, "db down");
  });

  it("a failed staging cleanup is logged and the deployment still fails", async () => {
    const errors = silenceErrors();
    repo.markScriptStarted.mockRejectedValue(new Error("db down"));
    ssh.executeRemoteCommand.mockRejectedValue(new Error("connect refused"));

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(errors).toHaveBeenCalledWith(
      "Deploy: could not remove the staged artifact:",
      expect.any(Error)
    );
    expect(repo.finishDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID, "failed");
  });

  it("a non-zero exit of the deploy script fails the deployment and leaves cleanup to the script", async () => {
    ssh.executeRemoteCommand.mockRejectedValue(
      new Error("SSH Command Failed (exit 1): UNIT NOT FOUND")
    );

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(repo.markScriptStarted).toHaveBeenCalledTimes(1);
    // Only the script itself: its EXIT trap owns the staging dir.
    expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
    expect(repo.finishDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID, "failed");
    expect(outputLines()).toContain(
      "✗ SSH Command Failed (exit 1): UNIT NOT FOUND"
    );
  });

  it("a jar target without a jar name or unit aborts before the registry", async () => {
    repo.getTarget.mockResolvedValue({ ...jarTarget, systemdUnit: null });

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(registry.openArtifactLayer).not.toHaveBeenCalled();
    expect(repo.markScriptStarted).not.toHaveBeenCalled();
  });

  it("cancels the layer stream when the run output cannot be written", async () => {
    const cancel = vi.spyOn(layerStream, "cancel");
    progress.appendRunOutput.mockRejectedValueOnce(new Error("db down"));

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(cancel).toHaveBeenCalled();
    expect(ssh.pipeToRemoteCommand).not.toHaveBeenCalled();
  });
});

describe("handleDeploy for a static target", () => {
  it("extracts beside the web root and runs the static script", async () => {
    useTarget(staticTarget);

    await expect(handleDeploy(payload)).resolves.toEqual({
      status: "success",
    });

    expect(registry.openArtifactLayer).toHaveBeenCalledWith(
      "core-web-frontend-deploy",
      TAG
    );
    expect(ssh.pipeToRemoteCommand).toHaveBeenCalledWith(
      credentials,
      buildArtifactExtractCommand(STATIC_STAGING),
      layerStream,
      { timeoutMs: 10 * 60_000 }
    );
    expect(ssh.executeRemoteCommand).toHaveBeenCalledWith(
      credentials,
      buildArtifactDeployScript({
        kind: "static",
        deployDir: "/var/www/core",
        deploymentId: DEPLOYMENT_ID,
        healthTimeoutSeconds: 180,
      }),
      20 * 60_000
    );
    expect(composeScript.buildDeployScript).not.toHaveBeenCalled();
    expect(processor.handleCreateDatabaseBackup).not.toHaveBeenCalled();
  });
});

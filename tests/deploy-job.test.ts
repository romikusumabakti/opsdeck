import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TARGET_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789a2";
const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789a3";
const DEPLOYMENT_ID = "0197f3a0-1b2c-7def-8000-0123456789a4";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789a5";
const BACKUP_RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789a6";
const TAG = "origin-sucor-development-abc1234";

const target = {
  id: TARGET_ID,
  environmentId: ENV_ID,
  componentKey: "dplk-accounting",
  serverId: SERVER_ID,
  sourceBranch: "sucor/development",
  autoDeploy: true,
  deployDir: "/opt/dplk-accounting",
  services: ["backend", "frontend"],
  tagVariable: "IMAGE_TAG",
  preStartCommand: null,
  healthUrl: null,
  healthTimeoutSeconds: 180,
  backupBeforeDeploy: false,
};

const repo = vi.hoisted(() => ({
  getTarget: vi.fn(),
  getDeployment: vi.fn(),
  insertDeployment: vi.fn(),
  supersedeQueuedAuto: vi.fn(),
  claimDeployment: vi.fn(),
  finishDeployment: vi.fn(),
  heartbeatDeployment: vi.fn(),
  markScriptStarted: vi.fn(),
  failStaleRunningDeployments: vi.fn(),
  listTagVariablesInDeployDir: vi.fn(),
  deployDirSharedWithOtherEnvironment: vi.fn(),
}));
vi.mock("@/lib/deploy/repository", () => repo);

const apps = vi.hoisted(() => ({ getComponent: vi.fn() }));
vi.mock("@/lib/apps", () => apps);

const ssh = vi.hoisted(() => ({
  executeRemoteCommand: vi.fn(),
  uploadRemoteContent: vi.fn(),
}));
vi.mock("@/lib/ssh", () => ssh);

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
}));
vi.mock("@/server/services/variables", () => variables);

const { handleDeploy, HEARTBEAT_INTERVAL_MS, STALE_RUNNING_DEPLOY_MS } =
  await import("@/lib/jobs/deploy");
const { requestDeployment } = await import("@/server/services/deployments");
const { buildDeployScript } = await import("@/lib/deploy/script");

const payload = { deploymentId: DEPLOYMENT_ID, runId: RUN_ID };

function outputLines(): string[] {
  return progress.appendRunOutput.mock.calls.map((c) => c[1] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEPLOY_REGISTRY", "192.168.56.113:5000");
  repo.getTarget.mockResolvedValue(target);
  apps.getComponent.mockResolvedValue({
    componentKey: "dplk-accounting",
    bundleImage: "dplk-accounting-deploy",
  });
  repo.getDeployment.mockResolvedValue({
    id: DEPLOYMENT_ID,
    targetId: TARGET_ID,
    environmentId: ENV_ID,
    runId: RUN_ID,
    tag: TAG,
    trigger: "auto",
    status: "running",
  });
  repo.insertDeployment.mockResolvedValue({ id: DEPLOYMENT_ID });
  repo.claimDeployment.mockResolvedValue("claimed");
  repo.finishDeployment.mockResolvedValue(true);
  repo.heartbeatDeployment.mockResolvedValue(true);
  repo.markScriptStarted.mockResolvedValue(undefined);
  repo.failStaleRunningDeployments.mockResolvedValue([]);
  environments.loadServerCredentials.mockResolvedValue({
    host: "10.0.0.5",
    username: "ops",
    password: "pw",
  });
  progress.createRun.mockResolvedValue(RUN_ID);
  ssh.executeRemoteCommand.mockResolvedValue("HEALTHY\n");
  ssh.uploadRemoteContent.mockResolvedValue(undefined);
  variables.loadManagedEnvFileVariables.mockResolvedValue(null);
  repo.listTagVariablesInDeployDir.mockResolvedValue(["IMAGE_TAG"]);
  repo.deployDirSharedWithOtherEnvironment.mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// For tests where a best-effort write fails on purpose and gets logged.
function silenceErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("handleDeploy", () => {
  it("superseded deployment does nothing on the server", async () => {
    repo.claimDeployment.mockResolvedValue("superseded");

    await expect(handleDeploy(payload)).resolves.toEqual({
      status: "superseded",
    });

    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(processor.handleCreateDatabaseBackup).not.toHaveBeenCalled();
    expect(repo.finishDeployment).not.toHaveBeenCalled();
    expect(outputLines()).toContain("Superseded by a newer build");
    expect(progress.completeRun).toHaveBeenCalledWith(RUN_ID);
  });

  it("busy environment re-enqueues with delayMs 15000 and no SSH", async () => {
    repo.claimDeployment.mockResolvedValue("busy");

    await expect(handleDeploy(payload)).resolves.toEqual({
      status: "requeued",
    });

    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledWith(
      "deploy/run.requested",
      payload,
      { delayMs: 15000 }
    );
    expect(outputLines()).toContain(
      "Waiting for the running deploy in this environment"
    );
    expect(progress.completeRun).not.toHaveBeenCalled();
    expect(progress.failRun).not.toHaveBeenCalled();
  });

  it("busy environment sweeps stale running deployments before waiting", async () => {
    repo.claimDeployment.mockResolvedValue("busy");
    repo.failStaleRunningDeployments.mockResolvedValue([BACKUP_RUN_ID]);

    await handleDeploy(payload);

    expect(repo.failStaleRunningDeployments).toHaveBeenCalledWith(
      STALE_RUNNING_DEPLOY_MS
    );
    expect(STALE_RUNNING_DEPLOY_MS).toBe(5 * 60_000);
    const message =
      "Marked failed: no progress for over 5 minutes (worker restart?)";
    expect(progress.appendRunOutput).toHaveBeenCalledWith(
      BACKUP_RUN_ID,
      message
    );
    expect(progress.failRun).toHaveBeenCalledWith(BACKUP_RUN_ID, message);
    expect(progress.failRun).not.toHaveBeenCalledWith(
      RUN_ID,
      expect.anything()
    );
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("a failing stale sweep still re-enqueues the busy deployment", async () => {
    silenceErrors();
    repo.claimDeployment.mockResolvedValue("busy");
    repo.failStaleRunningDeployments.mockRejectedValue(new Error("db down"));

    await expect(handleDeploy(payload)).resolves.toEqual({
      status: "requeued",
    });

    expect(queue.enqueue).toHaveBeenCalledWith(
      "deploy/run.requested",
      payload,
      { delayMs: 15000 }
    );
  });

  it("redelivered running deployment is failed, not reported as success", async () => {
    repo.claimDeployment.mockResolvedValue("interrupted");

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    const message = "Worker restarted during deploy — server state unknown";
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(repo.finishDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID, "failed");
    expect(outputLines()).toContain(message);
    expect(progress.failRun).toHaveBeenCalledWith(RUN_ID, message);
    expect(progress.completeRun).not.toHaveBeenCalled();
  });

  it("duplicate delivery of a finished deployment leaves the run untouched", async () => {
    repo.claimDeployment.mockResolvedValue("finished");

    await expect(handleDeploy(payload)).resolves.toEqual({
      status: "already-finished",
    });

    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(repo.finishDeployment).not.toHaveBeenCalled();
    expect(progress.appendRunOutput).not.toHaveBeenCalled();
    expect(progress.completeRun).not.toHaveBeenCalled();
    expect(progress.failRun).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("a failing run-output write in the failure path still fails the deployment", async () => {
    silenceErrors();
    ssh.executeRemoteCommand.mockRejectedValue(
      new Error("SSH Command Failed (exit 1): HEALTH TIMEOUT")
    );
    progress.appendRunOutput.mockImplementation(async (_id, line: string) => {
      if (line.startsWith("✗")) throw new Error("db down");
    });

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(repo.finishDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID, "failed");
    expect(progress.failRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.stringContaining("HEALTH TIMEOUT")
    );
  });

  it("a completeRun error after a successful deploy does not fail the run", async () => {
    const errors = silenceErrors();
    progress.completeRun.mockRejectedValue(new Error("db blip"));

    await expect(handleDeploy(payload)).resolves.toEqual({
      status: "success",
    });

    expect(repo.finishDeployment).toHaveBeenCalledTimes(1);
    expect(repo.finishDeployment).toHaveBeenCalledWith(
      DEPLOYMENT_ID,
      "success"
    );
    expect(progress.failRun).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
  });

  it("a deploy the stale sweep already failed is not reported as success", async () => {
    repo.finishDeployment.mockResolvedValue(false);

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(progress.completeRun).not.toHaveBeenCalled();
  });

  it("backup that throws before its own run handling gets its run failed", async () => {
    repo.getTarget.mockResolvedValue({ ...target, backupBeforeDeploy: true });
    progress.createRun.mockResolvedValue(BACKUP_RUN_ID);
    processor.handleCreateDatabaseBackup.mockRejectedValue(
      new Error(`Environment ${ENV_ID} not found`)
    );

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(progress.failRun).toHaveBeenCalledWith(
      BACKUP_RUN_ID,
      `Environment ${ENV_ID} not found`
    );
    expect(progress.failRun).toHaveBeenCalledWith(
      RUN_ID,
      "Backup failed — deploy aborted"
    );
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
  });

  it("a deployment the sweep failed while waiting sends no SSH command", async () => {
    repo.getTarget.mockResolvedValue({ ...target, backupBeforeDeploy: true });
    processor.handleCreateDatabaseBackup.mockResolvedValue({ success: true });
    repo.heartbeatDeployment.mockResolvedValue(false);

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(repo.heartbeatDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID);
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(repo.markScriptStarted).not.toHaveBeenCalled();
    const message =
      "Deployment was marked failed while waiting (stale) — not deploying";
    expect(outputLines()).toContain(message);
    expect(progress.failRun).toHaveBeenCalledWith(RUN_ID, message);
    expect(progress.completeRun).not.toHaveBeenCalled();
  });

  it("records the script start after the heartbeat gate and before SSH", async () => {
    await expect(handleDeploy(payload)).resolves.toEqual({ status: "success" });

    expect(repo.markScriptStarted).toHaveBeenCalledWith(DEPLOYMENT_ID);
    const gate = repo.heartbeatDeployment.mock.invocationCallOrder.at(-1) ?? 0;
    const marked = repo.markScriptStarted.mock.invocationCallOrder[0] ?? 0;
    const sent = ssh.executeRemoteCommand.mock.invocationCallOrder[0] ?? 0;
    expect(gate).toBeLessThan(marked);
    expect(marked).toBeLessThan(sent);
  });

  it("does not touch the server when the script start cannot be recorded", async () => {
    repo.markScriptStarted.mockRejectedValue(new Error("db down"));

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(repo.finishDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID, "failed");
  });

  describe("heartbeat", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // A deploy script that stays on the server until `finish` is called.
    function slowDeploy() {
      let finish: (outcome: Error | null) => void = () => {};
      ssh.executeRemoteCommand.mockImplementation(
        () =>
          new Promise<string>((resolve, reject) => {
            finish = (outcome) =>
              outcome ? reject(outcome) : resolve("HEALTHY\n");
          })
      );
      return (outcome: Error | null) => finish(outcome);
    }

    it("beats every interval while the deploy runs and stops on success", async () => {
      const finish = slowDeploy();
      const job = handleDeploy(payload);
      await vi.waitFor(() =>
        expect(ssh.executeRemoteCommand).toHaveBeenCalled()
      );
      const beforeSsh = repo.heartbeatDeployment.mock.calls.length;

      await vi.advanceTimersByTimeAsync(3 * HEARTBEAT_INTERVAL_MS);
      expect(repo.heartbeatDeployment.mock.calls.length).toBe(beforeSsh + 3);

      finish(null);
      await expect(job).resolves.toEqual({ status: "success" });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops beating when the deploy fails", async () => {
      const finish = slowDeploy();
      const job = handleDeploy(payload);
      await vi.waitFor(() =>
        expect(ssh.executeRemoteCommand).toHaveBeenCalled()
      );

      finish(new Error("SSH Command Failed (exit 1): HEALTH TIMEOUT"));
      await expect(job).resolves.toEqual({ status: "failed" });
      expect(vi.getTimerCount()).toBe(0);

      const calls = repo.heartbeatDeployment.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3 * HEARTBEAT_INTERVAL_MS);
      expect(repo.heartbeatDeployment.mock.calls.length).toBe(calls);
    });
  });

  it("backup failure aborts before any deploy command", async () => {
    repo.getTarget.mockResolvedValue({ ...target, backupBeforeDeploy: true });
    progress.createRun.mockResolvedValue(BACKUP_RUN_ID);
    processor.handleCreateDatabaseBackup.mockRejectedValue(
      new Error("pg_dump failed")
    );

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(progress.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "backup",
        environmentId: ENV_ID,
        userId: null,
      })
    );
    expect(processor.handleCreateDatabaseBackup).toHaveBeenCalledWith({
      environmentId: ENV_ID,
      runId: BACKUP_RUN_ID,
    });
    const scripts = ssh.executeRemoteCommand.mock.calls.map(
      (c) => c[1] as string
    );
    expect(scripts.some((s) => s.includes("compose up"))).toBe(false);
    expect(outputLines()).toContain("Backup failed — deploy aborted");
    // Never reached the server, so it does not change the current tag.
    expect(repo.markScriptStarted).not.toHaveBeenCalled();
    expect(repo.finishDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID, "failed");
    expect(progress.failRun).toHaveBeenCalledWith(RUN_ID, expect.any(String));
    expect(progress.completeRun).not.toHaveBeenCalled();
  });

  it("health failure marks failed and does not enqueue a rollback", async () => {
    ssh.executeRemoteCommand.mockRejectedValue(
      new Error("SSH Command Failed (exit 1): HEALTH TIMEOUT")
    );

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(repo.finishDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID, "failed");
    expect(progress.failRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.stringContaining("HEALTH TIMEOUT")
    );
    expect(progress.completeRun).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("success completes run and deployment", async () => {
    await expect(handleDeploy(payload)).resolves.toEqual({
      status: "success",
    });

    expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
    const [creds, script, timeoutMs] =
      ssh.executeRemoteCommand.mock.calls[0] ?? [];
    expect(creds).toEqual({
      host: "10.0.0.5",
      username: "ops",
      password: "pw",
    });
    expect(script).toContain(
      `192.168.56.113:5000/dplk-accounting-deploy:${TAG}`
    );
    expect(script).toContain("compose up");
    expect(timeoutMs).toBe(20 * 60_000);
    expect(environments.loadServerCredentials).toHaveBeenCalledWith(SERVER_ID);
    expect(processor.handleCreateDatabaseBackup).not.toHaveBeenCalled();
    expect(outputLines()).toContain("HEALTHY");
    expect(repo.finishDeployment).toHaveBeenCalledWith(
      DEPLOYMENT_ID,
      "success"
    );
    expect(progress.completeRun).toHaveBeenCalledWith(RUN_ID);
    expect(progress.failRun).not.toHaveBeenCalled();
  });

  it("fails without SSH when DEPLOY_REGISTRY is unset", async () => {
    vi.stubEnv("DEPLOY_REGISTRY", "");

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(outputLines()).toContain(
      "Deploy disabled: DEPLOY_REGISTRY is not set"
    );
    expect(repo.finishDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID, "failed");
    expect(progress.failRun).toHaveBeenCalled();
  });

  it("an unexpected error after the claim never leaves the deployment running", async () => {
    environments.loadServerCredentials.mockRejectedValue(
      new Error("decrypt failed")
    );

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(repo.finishDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID, "failed");
    expect(progress.failRun).toHaveBeenCalledWith(RUN_ID, "decrypt failed");
  });
});

// Distinctive secret strings: none of them, nor the names of the variables,
// may appear in run output, failure messages or any command sent over SSH.
const SECRETS = {
  DB_PASSWORD: "s3cr3t-Pa55word-XYZZY",
  API_TOKEN: "tok-QWERTY-998877 with $HOME #x",
};
const managedVars = [
  { name: "DB_PASSWORD", value: SECRETS.DB_PASSWORD },
  { name: "API_TOKEN", value: SECRETS.API_TOKEN },
  { name: "APP_URL", value: "https://app.example.test" },
];
const STAGED_PATH = `/opt/dplk-accounting/.env.opsdeck-new.${DEPLOYMENT_ID}`;

function everythingVisible(): string {
  return [
    ...progress.appendRunOutput.mock.calls.map((c) => String(c[1])),
    ...progress.failRun.mock.calls.map((c) => String(c[1])),
    ...ssh.executeRemoteCommand.mock.calls.map((c) => String(c[1])),
  ].join("\n");
}

function expectNoSecrets(): void {
  const visible = everythingVisible();
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(visible).not.toContain(value);
    expect(visible).not.toContain(name);
  }
}

function uploadedContent(): string {
  return String(ssh.uploadRemoteContent.mock.calls[0]?.[1]);
}

describe("handleDeploy with a managed .env", () => {
  // Review Focus 2.
  it("an unmanaged environment uploads nothing and runs today's script", async () => {
    await expect(handleDeploy(payload)).resolves.toEqual({ status: "success" });

    expect(variables.loadManagedEnvFileVariables).toHaveBeenCalledWith(ENV_ID);
    expect(ssh.uploadRemoteContent).not.toHaveBeenCalled();
    expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
    expect(ssh.executeRemoteCommand.mock.calls[0]?.[1]).toBe(
      buildDeployScript({
        registry: "192.168.56.113:5000",
        bundleImage: "dplk-accounting-deploy",
        tag: TAG,
        deployDir: target.deployDir,
        services: target.services,
        tagVariable: target.tagVariable,
        preStartCommand: target.preStartCommand,
        healthUrl: target.healthUrl,
        healthTimeoutSeconds: target.healthTimeoutSeconds,
      })
    );
    expect(outputLines().some((l) => l.startsWith("Staged .env"))).toBe(false);
  });

  it("uploads the rendered .env (0600) before the script, which installs it", async () => {
    variables.loadManagedEnvFileVariables.mockResolvedValue(managedVars);

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "success" });

    expect(ssh.uploadRemoteContent).toHaveBeenCalledTimes(1);
    const [creds, content, path, mode] =
      ssh.uploadRemoteContent.mock.calls[0] ?? [];
    expect(creds).toEqual({
      host: "10.0.0.5",
      username: "ops",
      password: "pw",
    });
    expect(path).toBe(STAGED_PATH);
    expect(mode).toBe(0o600);
    expect(content).toContain(`DB_PASSWORD='${SECRETS.DB_PASSWORD}'`);
    expect(content).toContain("APP_URL='https://app.example.test'");
    expect(content).toMatch(new RegExp(`\nIMAGE_TAG=${TAG}\n$`));

    // Single component: no read of the server's .env, only the script.
    expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
    const script = String(ssh.executeRemoteCommand.mock.calls[0]?.[1]);
    expect(script).toContain(`mv -f '.env.opsdeck-new.${DEPLOYMENT_ID}' .env`);
    expect(script).toContain("echo 'Wrote .env (3 variables)'");
    const uploaded = ssh.uploadRemoteContent.mock.invocationCallOrder[0] ?? 0;
    const marked = repo.markScriptStarted.mock.invocationCallOrder[0] ?? 0;
    const sent = ssh.executeRemoteCommand.mock.invocationCallOrder[0] ?? 0;
    expect(uploaded).toBeLessThan(marked);
    expect(marked).toBeLessThan(sent);

    expect(outputLines()).toContain("Staged .env (3 variables)");
    expectNoSecrets();
  });

  // Review Focus 3.
  it("a failed upload fails the deployment without running the script", async () => {
    variables.loadManagedEnvFileVariables.mockResolvedValue(managedVars);
    ssh.uploadRemoteContent.mockRejectedValue(new Error("Permission denied"));

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(repo.markScriptStarted).not.toHaveBeenCalled();
    expect(repo.finishDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID, "failed");
    expect(progress.failRun).toHaveBeenCalledWith(
      RUN_ID,
      expect.stringContaining("Permission denied")
    );
    expect(outputLines().some((l) => l.startsWith("Staged .env"))).toBe(false);
    expectNoSecrets();
  });

  it("variables that cannot be rendered fail the deploy before the backup", async () => {
    repo.getTarget.mockResolvedValue({ ...target, backupBeforeDeploy: true });
    variables.loadManagedEnvFileVariables.mockResolvedValue([
      ...managedVars,
      { name: "IMAGE_TAG", value: SECRETS.DB_PASSWORD },
    ]);

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(processor.handleCreateDatabaseBackup).not.toHaveBeenCalled();
    expect(ssh.uploadRemoteContent).not.toHaveBeenCalled();
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expectNoSecrets();
  });

  it("a deploy dir another environment also deploys into fails before the backup", async () => {
    repo.getTarget.mockResolvedValue({ ...target, backupBeforeDeploy: true });
    variables.loadManagedEnvFileVariables.mockResolvedValue(managedVars);
    repo.deployDirSharedWithOtherEnvironment.mockResolvedValue(true);

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(repo.deployDirSharedWithOtherEnvironment).toHaveBeenCalledWith(
      SERVER_ID,
      "/opt/dplk-accounting",
      ENV_ID
    );
    expect(processor.handleCreateDatabaseBackup).not.toHaveBeenCalled();
    expect(ssh.uploadRemoteContent).not.toHaveBeenCalled();
    expect(ssh.executeRemoteCommand).not.toHaveBeenCalled();
    expect(progress.failRun).toHaveBeenCalledWith(
      RUN_ID,
      "Another environment deploys into /opt/dplk-accounting — a managed .env needs the directory to itself"
    );
  });

  it("removes the staged file when the script start cannot be recorded", async () => {
    variables.loadManagedEnvFileVariables.mockResolvedValue(managedVars);
    repo.markScriptStarted.mockRejectedValue(new Error("db down"));
    ssh.executeRemoteCommand.mockResolvedValue("");

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
    expect(ssh.executeRemoteCommand.mock.calls[0]?.[1]).toBe(
      `rm -f '${STAGED_PATH}'`
    );
    expect(progress.failRun).toHaveBeenCalledWith(RUN_ID, "db down");
  });

  it("removes the staged file when the script fails to run, and still fails", async () => {
    silenceErrors();
    variables.loadManagedEnvFileVariables.mockResolvedValue(managedVars);
    ssh.executeRemoteCommand
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    await expect(handleDeploy(payload)).resolves.toEqual({ status: "failed" });

    expect(ssh.executeRemoteCommand.mock.calls[1]?.[1]).toBe(
      `rm -f '${STAGED_PATH}'`
    );
    expect(progress.failRun).toHaveBeenCalledWith(
      RUN_ID,
      "connect ECONNREFUSED"
    );
  });

  describe("multi-component deploy dir", () => {
    const backendTarget = {
      ...target,
      componentKey: "dplk-customer-portal-backend",
      deployDir: "/opt/portal",
      tagVariable: "BACKEND_IMAGE_TAG",
    };

    beforeEach(() => {
      repo.getTarget.mockResolvedValue(backendTarget);
      variables.loadManagedEnvFileVariables.mockResolvedValue(managedVars);
      repo.listTagVariablesInDeployDir.mockResolvedValue([
        "BACKEND_IMAGE_TAG",
        "FRONTEND_IMAGE_TAG",
      ]);
    });

    it("keeps the other component's tag from the server's .env", async () => {
      ssh.executeRemoteCommand
        .mockResolvedValueOnce("FRONTEND_IMAGE_TAG=fe-main-1234567\n")
        .mockResolvedValueOnce("HEALTHY\n");

      await expect(handleDeploy(payload)).resolves.toEqual({
        status: "success",
      });

      expect(repo.listTagVariablesInDeployDir).toHaveBeenCalledWith(
        SERVER_ID,
        "/opt/portal"
      );
      const read = String(ssh.executeRemoteCommand.mock.calls[0]?.[1]);
      expect(read).toContain("'/opt/portal'");
      expect(read).toContain("FRONTEND_IMAGE_TAG");
      expect(read).not.toContain("BACKEND_IMAGE_TAG");
      const content = uploadedContent();
      expect(content).toContain(`\nBACKEND_IMAGE_TAG=${TAG}\n`);
      expect(content).toContain("\nFRONTEND_IMAGE_TAG=fe-main-1234567\n");
      expect(ssh.uploadRemoteContent.mock.calls[0]?.[2]).toBe(
        `/opt/portal/.env.opsdeck-new.${DEPLOYMENT_ID}`
      );
      // The read happens before the upload, the script after it.
      const readAt = ssh.executeRemoteCommand.mock.invocationCallOrder[0] ?? 0;
      const upAt = ssh.uploadRemoteContent.mock.invocationCallOrder[0] ?? 0;
      const runAt = ssh.executeRemoteCommand.mock.invocationCallOrder[1] ?? 0;
      expect(readAt).toBeLessThan(upAt);
      expect(upAt).toBeLessThan(runAt);
      expectNoSecrets();
    });

    it("reads quoted values and takes the last line, as Compose does", async () => {
      ssh.executeRemoteCommand
        .mockResolvedValueOnce(
          'FRONTEND_IMAGE_TAG=fe-old-1\nFRONTEND_IMAGE_TAG="fe-new-2"\r\n'
        )
        .mockResolvedValueOnce("HEALTHY\n");

      await expect(handleDeploy(payload)).resolves.toEqual({
        status: "success",
      });
      expect(uploadedContent()).toContain("\nFRONTEND_IMAGE_TAG=fe-new-2\n");
    });

    it("leaves out a tag the server's .env does not have", async () => {
      ssh.executeRemoteCommand
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("HEALTHY\n");

      await expect(handleDeploy(payload)).resolves.toEqual({
        status: "success",
      });
      expect(uploadedContent()).not.toContain("FRONTEND_IMAGE_TAG");
      expect(uploadedContent()).toContain(`BACKEND_IMAGE_TAG=${TAG}`);
    });

    it("a failing read of the server's .env (grep exit 2) fails before the upload", async () => {
      ssh.executeRemoteCommand.mockRejectedValueOnce(
        new Error("SSH Command Failed (exit 1): grep: .env: Permission denied")
      );

      await expect(handleDeploy(payload)).resolves.toEqual({
        status: "failed",
      });
      expect(ssh.uploadRemoteContent).not.toHaveBeenCalled();
      expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
      expect(repo.markScriptStarted).not.toHaveBeenCalled();
    });

    it("the read command, run under sh: only tag lines; missing .env ok; unreadable .env fails", async () => {
      const dir = mkdtempSync(join(tmpdir(), "deploy-read-tags-"));
      try {
        repo.getTarget.mockResolvedValue({ ...backendTarget, deployDir: dir });
        ssh.executeRemoteCommand.mockRejectedValueOnce(new Error("stop here"));
        await handleDeploy(payload);
        const command = String(ssh.executeRemoteCommand.mock.calls[0]?.[1]);
        expect(command).not.toContain(SECRETS.DB_PASSWORD);
        const run = () =>
          spawnSync("sh", ["-c", command], { encoding: "utf8" });

        expect(run().status).toBe(0); // no .env yet
        writeFileSync(
          join(dir, ".env"),
          `DB_PASSWORD='${SECRETS.DB_PASSWORD}'\nFRONTEND_IMAGE_TAG=fe-1\nBACKEND_IMAGE_TAG=be-1\n`
        );
        const ok = run();
        expect(ok.status).toBe(0);
        expect(ok.stdout).toBe("FRONTEND_IMAGE_TAG=fe-1\n");
        writeFileSync(join(dir, ".env"), "OTHER=1\n");
        expect(run().status).toBe(0); // grep exit 1: no match is fine
        chmodSync(join(dir, ".env"), 0o000);
        // grep exit 2 (root reads anything, so only checked as a user)
        if (process.getuid?.() !== 0) expect(run().status).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("an invalid tag on the server aborts before the upload", async () => {
      ssh.executeRemoteCommand.mockResolvedValueOnce(
        "FRONTEND_IMAGE_TAG=latest\n"
      );

      await expect(handleDeploy(payload)).resolves.toEqual({
        status: "failed",
      });
      expect(ssh.uploadRemoteContent).not.toHaveBeenCalled();
      expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
      expect(progress.failRun).toHaveBeenCalledWith(
        RUN_ID,
        expect.stringContaining("FRONTEND_IMAGE_TAG")
      );
    });

    it("an unmanaged environment does not read the server's .env", async () => {
      variables.loadManagedEnvFileVariables.mockResolvedValue(null);

      await expect(handleDeploy(payload)).resolves.toEqual({
        status: "success",
      });
      expect(ssh.executeRemoteCommand).toHaveBeenCalledTimes(1);
      expect(ssh.uploadRemoteContent).not.toHaveBeenCalled();
    });
  });
});

describe("requestDeployment", () => {
  it("requestDeployment(auto) supersedes older queued auto deployments of the same target", async () => {
    const result = await requestDeployment({
      targetId: TARGET_ID,
      tag: TAG,
      trigger: "auto",
      userId: null,
      buildId: null,
    });

    expect(result).toEqual({ deploymentId: DEPLOYMENT_ID, runId: RUN_ID });
    expect(progress.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "deploy",
        environmentId: ENV_ID,
        userId: null,
        description: `Deploy dplk-accounting ${TAG} (auto)`,
      })
    );
    expect(repo.insertDeployment).toHaveBeenCalledWith({
      targetId: TARGET_ID,
      environmentId: ENV_ID,
      runId: RUN_ID,
      tag: TAG,
      trigger: "auto",
      buildId: null,
    });
    expect(repo.supersedeQueuedAuto).toHaveBeenCalledWith(
      TARGET_ID,
      DEPLOYMENT_ID
    );
    expect(queue.enqueue).toHaveBeenCalledWith("deploy/run.requested", {
      deploymentId: DEPLOYMENT_ID,
      runId: RUN_ID,
    });
  });

  it("a manual deployment supersedes nothing", async () => {
    await requestDeployment({
      targetId: TARGET_ID,
      tag: TAG,
      trigger: "manual",
      userId: "0197f3a0-1b2c-7def-8000-0123456789a7",
      buildId: null,
    });

    expect(repo.supersedeQueuedAuto).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid tag before recording anything", async () => {
    await expect(
      requestDeployment({
        targetId: TARGET_ID,
        tag: "latest",
        trigger: "manual",
        userId: null,
        buildId: null,
      })
    ).rejects.toThrow();

    expect(progress.createRun).not.toHaveBeenCalled();
    expect(repo.insertDeployment).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

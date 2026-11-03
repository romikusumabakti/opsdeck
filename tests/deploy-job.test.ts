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
  appKey: "dplk-accounting",
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
  getDeployApp: vi.fn(),
  getTarget: vi.fn(),
  getDeployment: vi.fn(),
  insertDeployment: vi.fn(),
  supersedeQueuedAuto: vi.fn(),
  claimDeployment: vi.fn(),
  finishDeployment: vi.fn(),
}));
vi.mock("@/lib/deploy/repository", () => repo);

const ssh = vi.hoisted(() => ({ executeRemoteCommand: vi.fn() }));
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

const { handleDeploy } = await import("@/lib/jobs/deploy");
const { requestDeployment } = await import("@/server/services/deployments");

const payload = { deploymentId: DEPLOYMENT_ID, runId: RUN_ID };

function outputLines(): string[] {
  return progress.appendRunOutput.mock.calls.map((c) => c[1] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEPLOY_REGISTRY", "192.168.56.113:5000");
  repo.getTarget.mockResolvedValue(target);
  repo.getDeployApp.mockResolvedValue({
    appKey: "dplk-accounting",
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
  environments.loadServerCredentials.mockResolvedValue({
    host: "10.0.0.5",
    username: "ops",
    password: "pw",
  });
  progress.createRun.mockResolvedValue(RUN_ID);
  ssh.executeRemoteCommand.mockResolvedValue("HEALTHY\n");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleDeploy", () => {
  it("superseded deployment does nothing on the server", async () => {
    repo.claimDeployment.mockResolvedValue("gone");

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

import type { ProjectWithServers } from "@/lib/db/schema";
import { executeRemoteCommand } from "@/lib/ssh";
import { appendTaskOutput, completeTask, failTask } from "@/lib/task-progress";
import { inngest } from "./client";

export const syncJenkinsData = inngest.createFunction(
  { id: "sync-jenkins-data", triggers: { event: "jenkins/sync.data" } },
  async ({ event, step }) => {
    await step.sleep("wait-a-moment", "1s");
    return { message: `Hello ${event.data.email}!` };
  }
);

// Inngest's step.run signature is generic and Jsonifies its return type, which
// breaks a strict generic wrapper. Use a loose shape here and cast back at the
// call sites — runtime values are unchanged, the Jsonify is purely for the
// memoization layer.
type StepShape = {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
};

// Wraps a step so its label is appended to task output before/after running,
// and any thrown error gets logged then surfaced as a task failure.
async function tracked<T>(
  taskId: string,
  step: StepShape,
  id: string,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  await step.run(`${id}-log-start`, () => appendTaskOutput(taskId, label));
  try {
    return (await step.run(id, fn)) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await step.run(`${id}-log-fail`, () =>
      appendTaskOutput(taskId, `✗ ${label} — ${message}`)
    );
    throw err;
  }
}

export const createDatabaseBackup = inngest.createFunction(
  { id: "create-db-backup", triggers: { event: "db/backup.requested" } },
  async ({ event, step }) => {
    const { taskId, ...project } = event.data as ProjectWithServers & {
      taskId: string;
    };

    const credentials = {
      host: project.dbServer.host,
      username: project.dbServer.username,
      password: project.dbServer.password,
    };

    try {
      await tracked(
        taskId,
        step,
        "ensure-backup-dir",
        "Ensuring backup directory exists",
        async () => {
          await executeRemoteCommand(
            credentials,
            `mkdir -p ${project.dbBackupPath}`
          );
        }
      );

      const filename = await tracked(
        taskId,
        step,
        "run-pg-dump",
        `Running pg_dump for ${project.dbName}`,
        async () => {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const fname = `${project.dbName}_${ts}.sql.gz`;
          const cmd = `docker exec ${project.dbServiceName} pg_dump -U postgres ${project.dbName} | gzip > ${project.dbBackupPath}/${fname}`;
          await executeRemoteCommand(credentials, cmd);
          return fname;
        }
      );

      await step.run("finish", async () => {
        await appendTaskOutput(taskId, `✓ Backup file created: ${filename}`);
        await completeTask(taskId);
      });

      return { success: true, filename };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run("record-failure", () => failTask(taskId, message));
      throw err;
    }
  }
);

export const simulateProjectTimeLegacy = inngest.createFunction(
  {
    id: "simulate-project-time-legacy",
    triggers: { event: "project/simulate-time.legacy" },
  },
  async ({ event, step }) => {
    const { project, simulatedAt, taskId } = event.data as {
      project: ProjectWithServers;
      simulatedAt: string;
      taskId: string;
    };

    const credentials = {
      host: project.backendServer.host,
      username: project.backendServer.username,
      password: project.backendServer.password,
    };

    // `date -s` expects "YYYY-MM-DD HH:MM:SS"; convert from ISO so the shell
    // gets a clean argument and we don't depend on the remote host's locale.
    const d = new Date(simulatedAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateArg = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
      d.getUTCDate()
    )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(
      d.getUTCSeconds()
    )}`;

    try {
      await tracked(
        taskId,
        step,
        "disable-ntp",
        "Disabling NTP on backend server",
        async () => {
          // Stops the time daemon from reverting our manual override mid-test.
          await executeRemoteCommand(
            credentials,
            `echo '${credentials.password}' | sudo -S timedatectl set-ntp false`
          );
        }
      );

      await tracked(
        taskId,
        step,
        "set-system-time",
        `Setting system time to ${dateArg} UTC`,
        async () => {
          await executeRemoteCommand(
            credentials,
            `echo '${credentials.password}' | sudo -S date -u -s "${dateArg}"`
          );
        }
      );

      await tracked(
        taskId,
        step,
        "restart-backend",
        `Restarting backend service ${project.backendServiceName}`,
        async () => {
          const cmd =
            project.backendServiceType === "docker"
              ? `docker restart ${project.backendServiceName}`
              : `echo '${credentials.password}' | sudo -S systemctl restart ${project.backendServiceName}`;
          await executeRemoteCommand(credentials, cmd);
        }
      );

      await step.run("finish", async () => {
        await appendTaskOutput(taskId, "✓ Simulate-time complete");
        await completeTask(taskId);
      });

      return { success: true, simulatedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run("record-failure", () => failTask(taskId, message));
      throw err;
    }
  }
);

export const restoreDatabaseBackup = inngest.createFunction(
  { id: "restore-db-backup", triggers: { event: "db/restore.requested" } },
  async ({ event, step }) => {
    const data = event.data as ProjectWithServers & {
      filename: string;
      taskId: string;
    };
    const { filename, taskId } = data;
    const credentials = {
      host: data.dbServer.host,
      username: data.dbServer.username,
      password: data.dbServer.password,
    };
    const path = process.env.BACKUP_DIR;
    const container = process.env.DB_CONTAINER_NAME;
    const user = process.env.DB_USER;
    const dbName = process.env.DB_NAME;

    try {
      if (!filename) throw new Error("Filename is required");

      await tracked(
        taskId,
        step,
        "kill-connections",
        `Terminating active connections to ${dbName}`,
        async () => {
          const killCmd = `echo "SELECT pid, pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();" | docker exec -i ${container} psql -U ${user}`;
          await executeRemoteCommand(credentials, killCmd);
        }
      );

      await tracked(
        taskId,
        step,
        "perform-restore",
        `Restoring from ${filename}`,
        async () => {
          const cmd = `gunzip -c ${path}/${filename} | docker exec -i ${container} psql -U ${user} -d ${dbName}`;
          await executeRemoteCommand(credentials, cmd);
        }
      );

      await step.run("finish", async () => {
        await appendTaskOutput(taskId, `✓ Restore complete (${filename})`);
        await completeTask(taskId);
      });

      return { success: true, restored: filename };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.run("record-failure", () => failTask(taskId, message));
      throw err;
    }
  }
);

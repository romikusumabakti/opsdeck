import { db } from "@/lib/db";
import { type ProjectWithServers, tasks } from "@/lib/db/schema";
import { executeRemoteCommand } from "@/lib/ssh";
import { inngest } from "./client";

export const syncJenkinsData = inngest.createFunction(
  { id: "sync-jenkins-data", triggers: { event: "jenkins/sync.data" } },
  async ({ event, step }) => {
    await step.sleep("wait-a-moment", "1s");
    return { message: `Hello ${event.data.email}!` };
  }
);

export const createDatabaseBackup = inngest.createFunction(
  { id: "create-db-backup", triggers: { event: "db/backup.requested" } },
  async ({ event, step }) => {
    const { userId, ...project } = event.data as ProjectWithServers & {
      userId: string;
    };

    const credentials = {
      host: project.dbServer.host,
      username: project.dbServer.username,
      password: project.dbServer.password,
    };

    // Memoize start time so retries don't shift runAt forward.
    const runAt = await step.run("capture-start-time", () =>
      new Date().toISOString()
    );

    await step.run("ensure-backup-dir", async () => {
      await executeRemoteCommand(
        credentials,
        `mkdir -p ${project.dbBackupPath}`
      );
    });

    // pg_dump piped through gzip to save space and IO. Filename is generated
    // inside the step so it's stable across retries (memoized by Inngest).
    const filename = await step.run("run-pg-dump", async () => {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const fname = `${project.dbName}_${ts}.sql.gz`;
      const cmd = `docker exec ${project.dbServiceName} pg_dump -U postgres ${project.dbName} | gzip > ${project.dbBackupPath}/${fname}`;
      await executeRemoteCommand(credentials, cmd);
      return fname;
    });

    await step.run("record-task", async () => {
      await db.insert(tasks).values({
        projectId: project.id,
        userId,
        description: `Backup database (${filename})`,
        runAt: new Date(runAt),
        completedAt: new Date(),
      });
    });

    return { success: true, filename };
  }
);

export const simulateProjectTimeLegacy = inngest.createFunction(
  {
    id: "simulate-project-time-legacy",
    triggers: { event: "project/simulate-time.legacy" },
  },
  async ({ event, step }) => {
    const { project, simulatedAt, userId } = event.data as {
      project: ProjectWithServers;
      simulatedAt: string;
      userId: string;
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

    const runAt = await step.run("capture-start-time", () =>
      new Date().toISOString()
    );

    await step.run("disable-ntp", async () => {
      // Stops the time daemon from reverting our manual override mid-test.
      await executeRemoteCommand(
        credentials,
        `echo '${credentials.password}' | sudo -S timedatectl set-ntp false`
      );
    });

    await step.run("set-system-time", async () => {
      await executeRemoteCommand(
        credentials,
        `echo '${credentials.password}' | sudo -S date -u -s "${dateArg}"`
      );
    });

    await step.run("restart-backend", async () => {
      const cmd =
        project.backendServiceType === "docker"
          ? `docker restart ${project.backendServiceName}`
          : `echo '${credentials.password}' | sudo -S systemctl restart ${project.backendServiceName}`;
      await executeRemoteCommand(credentials, cmd);
    });

    await step.run("record-task", async () => {
      await db.insert(tasks).values({
        projectId: project.id,
        userId,
        description: `Simulate time to ${dateArg} (legacy)`,
        runAt: new Date(runAt),
        completedAt: new Date(),
      });
    });

    return { success: true, simulatedAt };
  }
);

export const restoreDatabaseBackup = inngest.createFunction(
  { id: "restore-db-backup", triggers: { event: "db/restore.requested" } },
  async ({ event, step }) => {
    const data = event.data as ProjectWithServers & {
      filename: string;
      userId: string;
    };
    const { filename, userId } = data;
    const credentials = {
      host: data.dbServer.host,
      username: data.dbServer.username,
      password: data.dbServer.password,
    };
    const path = process.env.BACKUP_DIR;
    const container = process.env.DB_CONTAINER_NAME;
    const user = process.env.DB_USER;
    const dbName = process.env.DB_NAME;

    if (!filename) throw new Error("Filename is required");

    const runAt = await step.run("capture-start-time", () =>
      new Date().toISOString()
    );

    // 1. Terminate existing connections
    // This SQL snippet kills all connections to the specific DB except our own runner
    await step.run("kill-connections", async () => {
      const killCmd = `echo "SELECT pid, pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();" | docker exec -i ${container} psql -U ${user}`;
      await executeRemoteCommand(credentials, killCmd);
    });

    // 2. Drop and Recreate (Optional but recommended for clean slate)
    // Or simpler: just run psql with --clean --if-exists flags in pg_dump options
    // Here we assume standard restore over existing schema
    await step.run("perform-restore", async () => {
      // gunzip the file on host and pipe into docker psql
      const cmd = `gunzip -c ${path}/${filename} | docker exec -i ${container} psql -U ${user} -d ${dbName}`;
      await executeRemoteCommand(credentials, cmd);
    });

    await step.run("record-task", async () => {
      await db.insert(tasks).values({
        projectId: data.id,
        userId,
        description: `Restore database from ${filename}`,
        runAt: new Date(runAt),
        completedAt: new Date(),
      });
    });

    return { success: true, restored: filename };
  }
);

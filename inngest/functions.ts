import type { Project } from "@/lib/db/schema";
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
    const project = event.data as Project;

    const credentials = {
      host: project.dbServerHost,
      username: project.dbServerUsername,
      password: project.dbServerPassword,
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${project.dbName}_${timestamp}.sql.gz`;

    // 1. Ensure directory exists
    await step.run("ensure-backup-dir", async () => {
      await executeRemoteCommand(
        credentials,
        `mkdir -p ${project.dbBackupPath}`
      );
    });

    // 2. Run pg_dump via Docker and pipe to host filesystem
    // We use gzip to save space and reduce IO
    await step.run("run-pg-dump", async () => {
      const cmd = `docker exec ${project.dbServiceName} pg_dump -U postgres ${project.dbName} | gzip > ${project.dbBackupPath}/${filename}`;
      await executeRemoteCommand(credentials, cmd);
      console.log(cmd);
      return { filename };
    });

    return { success: true, filename };
  }
);

export const restoreDatabaseBackup = inngest.createFunction(
  { id: "restore-db-backup", triggers: { event: "db/restore.requested" } },
  async ({ event, step }) => {
    const data = event.data as Project & { filename: string };
    const { filename } = data;
    const credentials = {
      host: data.dbServerHost,
      username: data.dbServerUsername,
      password: data.dbServerPassword,
    };
    const path = process.env.BACKUP_DIR;
    const container = process.env.DB_CONTAINER_NAME;
    const user = process.env.DB_USER;
    const db = process.env.DB_NAME;

    if (!filename) throw new Error("Filename is required");

    // 1. Terminate existing connections
    // This SQL snippet kills all connections to the specific DB except our own runner
    await step.run("kill-connections", async () => {
      const killCmd = `echo "SELECT pid, pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid();" | docker exec -i ${container} psql -U ${user}`;
      await executeRemoteCommand(credentials, killCmd);
    });

    // 2. Drop and Recreate (Optional but recommended for clean slate)
    // Or simpler: just run psql with --clean --if-exists flags in pg_dump options
    // Here we assume standard restore over existing schema
    await step.run("perform-restore", async () => {
      // gunzip the file on host and pipe into docker psql
      const cmd = `gunzip -c ${path}/${filename} | docker exec -i ${container} psql -U ${user} -d ${db}`;
      await executeRemoteCommand(credentials, cmd);
    });

    return { success: true, restored: filename };
  }
);

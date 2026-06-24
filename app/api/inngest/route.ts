import { serve } from "inngest/next";
import {
  controlService,
  createDatabaseBackup,
  createDatabaseFn,
  dropDatabaseFn,
  mockProjectTimeLegacy,
  mockProjectTimeResetLegacy,
  renameDatabaseFn,
  restoreDatabaseBackup,
} from "@/inngest/functions";
import { inngest } from "../../../inngest/client";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    createDatabaseBackup,
    restoreDatabaseBackup,
    createDatabaseFn,
    dropDatabaseFn,
    renameDatabaseFn,
    mockProjectTimeLegacy,
    mockProjectTimeResetLegacy,
    controlService,
  ],
});

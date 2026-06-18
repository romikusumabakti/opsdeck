import { serve } from "inngest/next";
import {
  controlService,
  createDatabaseBackup,
  createDatabaseFn,
  dropDatabaseFn,
  mockProjectTimeLegacy,
  mockProjectTimeResetLegacy,
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
    mockProjectTimeLegacy,
    mockProjectTimeResetLegacy,
    controlService,
  ],
});

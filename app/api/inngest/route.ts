import { serve } from "inngest/next";
import {
  controlService,
  createDatabaseBackup,
  mockProjectTimeLegacy,
  restoreDatabaseBackup,
  syncJenkinsData,
} from "@/inngest/functions";
import { inngest } from "../../../inngest/client";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    syncJenkinsData,
    createDatabaseBackup,
    restoreDatabaseBackup,
    mockProjectTimeLegacy,
    controlService,
  ],
});

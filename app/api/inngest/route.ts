import { serve } from "inngest/next";
import {
  controlService,
  createDatabaseBackup,
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
    mockProjectTimeLegacy,
    mockProjectTimeResetLegacy,
    controlService,
  ],
});

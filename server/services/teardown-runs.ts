import { TEARDOWN_ERRORS } from "@/lib/teardown/errors";
import { createRunUnlessTearingDown } from "@/lib/teardown/guard";
import { CodedHTTPException } from "@/server/errors";

/** The 409 of a change refused while the environment is being deleted. */
export function teardownRunningError(): CodedHTTPException {
  return new CodedHTTPException(
    409,
    "teardownRunning",
    TEARDOWN_ERRORS.teardownRunning
  );
}

/**
 * The run of an operation a teardown blocks (backup, restore, database
 * create/drop/rename, service start/stop/restart): 409 `teardownRunning`
 * instead while the environment is being deleted (lib/teardown/guard).
 */
export async function createRunOrRefuse(
  input: Parameters<typeof createRunUnlessTearingDown>[0]
): Promise<string> {
  const runId = await createRunUnlessTearingDown(input);
  if (runId === null) throw teardownRunningError();
  return runId;
}

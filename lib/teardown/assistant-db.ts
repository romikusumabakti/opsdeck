import {
  forgetAssistantDbLogin,
  turnOffAssistantDbAccess,
} from "@/lib/assistant-db/login";
import { disableAssistantDbLogin } from "@/lib/assistant-db/provision";
import { loadEnvironmentWithServers } from "@/lib/environments";
import { redactSecrets } from "@/lib/ssh";
import { HostKeyMismatchError } from "@/lib/ssh-connect";
import { StepFailed } from "@/lib/teardown/errors";
import type { TeardownStepSpec } from "@/lib/teardown/plan";

type ServiceParams = Extract<
  TeardownStepSpec,
  { kind: "drop_assistant_db_login" }
>["params"];

/**
 * drop_assistant_db_login: drops the Assistant's read-only login (any
 * engine) that the environment's db service records, while the database
 * still runs (before the stacks stop). The access is turned off first, so
 * the Assistant stops even when the drop fails; the step then fails like
 * any server step (serverCommandFailed, redacted) and a retry drops it. A
 * stopped database container fails the same way, saying so (as
 * archive_database does); the run waits for a retry, it never loops.
 * Ok when no login is recorded any more.
 */
export async function dropAssistantDbLogin(
  ctx: { environmentId: string; secrets: string[] },
  params: ServiceParams
): Promise<string> {
  const environment = await loadEnvironmentWithServers(ctx.environmentId);
  const service = environment?.services.find((s) => s.id === params.serviceId);
  if (service?.role !== "db") {
    throw new StepFailed("databaseNotRegistered");
  }
  const login = await turnOffAssistantDbAccess(service.id);
  if (!login) return "No Assistant database login to drop";
  for (const secret of [
    service.dbPassword,
    service.assistantDbPassword,
    service.server.password,
  ]) {
    if (secret) ctx.secrets.push(secret);
  }
  try {
    await disableAssistantDbLogin(service, {
      environmentId: ctx.environmentId,
      login,
    });
  } catch (error) {
    if (error instanceof HostKeyMismatchError) throw error;
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
      ctx.secrets
    );
    // Like archive_database, a stopped or missing database container is a
    // failure (the login may live on in its volume), named so the retry is
    // obvious: start the database, then retry.
    if (
      service.serviceType !== "systemd" &&
      /is not running|no such container|not found/i.test(message)
    ) {
      throw new StepFailed(
        "serverCommandFailed",
        `the database ${service.serviceName} is not running, so login ${login} could not be dropped; start it and retry: ${message}`
      );
    }
    throw new StepFailed("serverCommandFailed", message);
  }
  await forgetAssistantDbLogin(service.id, login);
  return `Assistant database login ${login} dropped`;
}

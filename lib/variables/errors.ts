// Messages of the variables API's 409s. The UI matches them to show its own
// text (ApiError carries only status and message), so they live here, shared
// by both sides.

/** 400 for a variable or template name with a reserved prefix. */
export const RESERVED_PREFIX_MESSAGE =
  "Variable names must not start with COMPOSE_, DOCKER_ or BUILDKIT_ (the Panel writes DOCKER_REGISTRY itself)";

/** Prefix of the 409 for turning on env_file_managed; the names follow it. */
export const MISSING_REQUIRED_PREFIX = "Missing required variables: ";

export const ESCROWED_MESSAGE =
  "Escrowed variables cannot be regenerated, deleted or changed";

export const ESCROW_REMOVAL_MESSAGE =
  "Escrow can only be removed explicitly (confirmEscrowRemoval) by an admin";

export const NOT_GENERATED_MESSAGE =
  "Only generated variables can be regenerated";

export const SECRET_TO_PLAIN_MESSAGE =
  "Enter a value when changing a secret to plain";

export const NO_APP_MESSAGE = "Environment has no app";

/** 409 for turning on env_file_managed in a deploy dir another env uses. */
export const SHARED_DEPLOY_DIR_MESSAGE =
  "Another environment deploys into this directory";

/** The variable names a MISSING_REQUIRED_PREFIX message lists, else null. */
export function missingRequiredNames(message: string): string[] | null {
  if (!message.startsWith(MISSING_REQUIRED_PREFIX)) return null;
  return message
    .slice(MISSING_REQUIRED_PREFIX.length)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

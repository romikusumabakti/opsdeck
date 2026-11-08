import { randomBytes } from "node:crypto";
import { z } from "zod";
import { RESERVED_PREFIX_MESSAGE } from "@/lib/variables/errors";

// Rules for the variables an environment's `.env` is rendered from
// (lib/variables/env-file.ts). Values are stored as one line each: the `.env`
// format has no safe way to carry a newline through every reader.

export const VARIABLE_VALUE_MAX_LENGTH = 8192;

const NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Docker Compose and the Docker CLI read variables with these prefixes from
 * the project's `.env` (`COMPOSE_PROJECT_NAME`, `COMPOSE_FILE`,
 * `DOCKER_HOST`, …): one could retarget the deploy at another stack, so no
 * variable may carry them.
 */
export const RESERVED_NAME_PREFIXES = ["COMPOSE_", "DOCKER_", "BUILDKIT_"];

export function hasReservedPrefix(name: string): boolean {
  return RESERVED_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * A variable name: upper-case letters, digits and `_`, not starting with a
 * digit or a {@link RESERVED_NAME_PREFIXES} prefix, at most 128 characters.
 * `reservedNames` are the environment's tag variable names; the deploy writes
 * those itself, so a variable may not take one.
 */
export function variableNameSchema(reservedNames: readonly string[] = []) {
  return z
    .string()
    .max(128)
    .regex(
      NAME_PATTERN,
      "Variable name must be uppercase letters, digits or '_', not starting with a digit"
    )
    .refine((name) => !hasReservedPrefix(name), RESERVED_PREFIX_MESSAGE)
    .refine(
      (name) => !reservedNames.includes(name),
      "Variable name is reserved for the image tag"
    );
}

/** A variable value: one line (no newline, carriage return or NUL). */
export const variableValueSchema = z
  .string()
  .max(VARIABLE_VALUE_MAX_LENGTH)
  .refine(
    (value) => !/[\n\r\0]/.test(value),
    "Value must be a single line, without line breaks or NUL"
  );

export interface PlaceholderContext {
  url: string | null;
  envSlug: string;
}

const PLACEHOLDER = /\{(url|envSlug)\}/g;

/**
 * Replaces `{url}` and `{envSlug}` with the environment's values in
 * one pass (a substituted value is not scanned again). Any other `{…}` is left
 * as is. Throws when a placeholder that occurs has no value.
 */
export function resolvePlaceholders(
  value: string,
  ctx: PlaceholderContext
): string {
  return value.replace(PLACEHOLDER, (_match, key: keyof PlaceholderContext) => {
    const replacement = ctx[key];
    if (replacement === null) {
      throw new Error(`Placeholder {${key}} has no value for this environment`);
    }
    return replacement;
  });
}

/**
 * A random value of exactly `length` URL-safe characters (`[A-Za-z0-9_-]`,
 * base64url of `crypto.randomBytes`), for generated variables.
 */
export function generateValue(length: number): string {
  if (
    !Number.isInteger(length) ||
    length < 1 ||
    length > VARIABLE_VALUE_MAX_LENGTH
  ) {
    throw new RangeError(
      `Generated value length must be an integer from 1 to ${VARIABLE_VALUE_MAX_LENGTH}`
    );
  }
  return randomBytes(Math.ceil((length * 3) / 4))
    .toString("base64url")
    .slice(0, length);
}

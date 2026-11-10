import { z } from "zod";
import { RESERVED_PREFIX_MESSAGE } from "@/lib/variables/errors";
import { hasReservedPrefix } from "@/lib/variables/validation";

// Input validation for the deploy feature. Every value here ends up in a shell
// script that runs on a client's Compose host or in an image reference, so the
// formats are deliberately narrow: they are a second line of defence behind
// `shq`, and they keep values safe in places quoting alone does not cover
// (a `sed` replacement, an image reference, a `.env` line).

/**
 * An image tag as produced by CI (`origin-<branch>-<shorthash>`). Never
 * `latest` in any casing: `latest` is not pushed to the registry, and a
 * floating tag would make "which version is deployed" unanswerable.
 */
export const deployTagSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
    "Tag must be 1-128 characters of letters, digits, '_', '.' or '-'"
  )
  .refine((tag) => tag.toLowerCase() !== "latest", "Tag must not be 'latest'");

/**
 * The registry the deploy bundle images are pulled from, as `host[:port]`
 * (`DEPLOY_REGISTRY`, e.g. `192.168.10.113:5000`). Checked at boot and again
 * when a deploy script is built.
 */
export const deployRegistrySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})(?::[0-9]{1,5})?$/,
    "Registry must be host[:port]"
  );

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const appKeySchema = z
  .string()
  .regex(KEY_PATTERN, "App key must be lowercase letters, digits or '-'");

export const componentKeySchema = z
  .string()
  .regex(KEY_PATTERN, "Component key must be lowercase letters, digits or '-'");

export const branchSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$/,
    "Branch must be letters, digits, '/', '_', '.' or '-'"
  )
  .refine((branch) => !branch.includes(".."), "Branch must not contain '..'");

export const envVarNameSchema = z
  .string()
  .regex(
    /^[A-Z_][A-Z0-9_]{0,63}$/,
    "Variable name must be uppercase letters, digits or '_'"
  );

// The deploy writes the tag line into the project's `.env`, so the name
// follows the same reserved-prefix rule as the variables there.
export const tagVariableSchema = envVarNameSchema.refine(
  (name) => !hasReservedPrefix(name),
  RESERVED_PREFIX_MESSAGE
);

/**
 * The bundle image's repository path, as Docker accepts it (registry and tag
 * are added when the deploy script is built).
 */
export const bundleImageSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/,
    "Bundle image must be a lowercase repository path"
  )
  .max(255);

/**
 * The directory the bundle is extracted into and compose runs in: an absolute
 * path at least two levels deep (never `/` or a top-level system directory),
 * with no empty, `.` or `..` segment.
 */
export const deployDirSchema = z
  .string()
  .regex(
    /^\/[A-Za-z0-9/_.-]+$/,
    "Deploy dir must be an absolute path of letters, digits, '/', '_', '.' or '-'"
  )
  .refine(
    (dir) => !dir.split("/").includes(".."),
    "Deploy dir must not contain a '..' segment"
  )
  .refine((dir) => {
    const segments = dir.slice(1).split("/");
    return (
      segments.length >= 2 &&
      segments.every((segment) => segment !== "" && segment !== ".")
    );
  }, "Deploy dir must be at least two levels deep, with no empty or '.' segment");

export const composeServiceSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_.-]{0,63}$/,
    "Service must be lowercase letters, digits, '_', '.' or '-'"
  );

// Deploy target settings. Free-form text goes into the server script, so these
// are deliberately narrow. Shared by the API and the target form.
export const servicesSchema = z
  .array(composeServiceSchema)
  .min(1)
  .max(20)
  .refine((list) => new Set(list).size === list.length, "Duplicate service");

// Jar targets: the file name the jar gets on the host, and the systemd unit
// that runs it. Both end up in a shell script and a `systemctl` call.
export const jarNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.jar$/,
    "Jar name must be a file name of letters, digits, '_', '.' or '-' ending in .jar"
  );

// Passed to systemctl as given: the script appends no `.service`.
export const systemdUnitSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9@._-]{0,99}$/,
    "Unit must be letters, digits, '@', '_', '.' or '-'"
  )
  .refine(
    (unit) => !unit.endsWith(".service"),
    "Unit must be given without the .service suffix"
  );

export const preStartCommandSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[^\r\n]*$/, "Must be a single line");

export const healthUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);

// The script waits stableSeconds (30) and then polls, so less cannot succeed.
// The upper bound keeps the health wait well inside the 20-minute SSH limit on
// the whole deploy script, so a slow stack ends in HEALTH TIMEOUT rather than
// an SSH timeout.
export const HEALTH_TIMEOUT_MAX_SECONDS = 900;
export const healthTimeoutSchema = z
  .number()
  .int()
  .min(60)
  .max(HEALTH_TIMEOUT_MAX_SECONDS);

export const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, "Commit SHA must be 7-40 lowercase hex digits");

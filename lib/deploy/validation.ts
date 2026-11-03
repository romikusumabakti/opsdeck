import { z } from "zod";

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

export const appKeySchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    "App key must be lowercase letters, digits or '-'"
  );

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

export const deployDirSchema = z
  .string()
  .regex(
    /^\/[A-Za-z0-9/_.-]+$/,
    "Deploy dir must be an absolute path of letters, digits, '/', '_', '.' or '-'"
  )
  .refine(
    (dir) => !dir.split("/").includes(".."),
    "Deploy dir must not contain a '..' segment"
  );

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

export const preStartCommandSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[^\r\n]*$/, "Must be a single line");

export const healthUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);

// The script waits stableSeconds (30) and then polls, so less cannot succeed.
export const healthTimeoutSchema = z.number().int().min(60).max(3600);

export const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, "Commit SHA must be 7-40 lowercase hex digits");

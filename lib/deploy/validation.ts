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

export const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, "Commit SHA must be 7-40 lowercase hex digits");

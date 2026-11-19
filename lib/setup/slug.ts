import { RESERVED_ENV_SLUGS } from "@/lib/reserved-paths";

// The URL-name rules of an environment, dependency-free so the browser's
// forms check a slug live with the same rules the server applies.

/** The longest slug a new environment or a rename may get (older ones may be longer). */
export const ENV_SLUG_MAX_LENGTH = 40;

const ENV_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `value` lowercased, every run of other characters turned into one `-`, cut
 * to `maxLength` without a hyphen left at either end. May be empty.
 */
export function slugify(value: string, maxLength: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
}

/** The URL-name base an environment name gives (`uniqueEnvSlug` adds -2, -3 on collision). */
export function baseEnvSlug(name: string): string {
  return slugify(name, ENV_SLUG_MAX_LENGTH) || "env";
}

export type EnvSlugProblem =
  | "environmentSlugInvalid"
  | "environmentSlugReserved";

/**
 * Why `slug` can't be an environment's URL name on its own (an actionErrors
 * code), else null: lowercase letters and digits in words joined by single
 * hyphens, 1–40 characters, and not one of the project's sub-routes. Whether
 * the project already uses it is the server's check.
 */
export function envSlugProblem(slug: string): EnvSlugProblem | null {
  if (slug.length > ENV_SLUG_MAX_LENGTH || !ENV_SLUG_PATTERN.test(slug)) {
    return "environmentSlugInvalid";
  }
  if (RESERVED_ENV_SLUGS.has(slug)) return "environmentSlugReserved";
  return null;
}

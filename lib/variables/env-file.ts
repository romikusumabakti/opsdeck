import {
  deployRegistrySchema,
  deployTagSchema,
  envVarNameSchema,
} from "@/lib/deploy/validation";
import {
  variableNameSchema,
  variableValueSchema,
} from "@/lib/variables/validation";

export const ENV_FILE_HEADER =
  "# Managed by DSS Panel — edit variables in the Panel; local edits are overwritten on the next deploy.";

/**
 * Quotes a value so Docker Compose reads it back byte for byte. Rules from
 * compose-go v2.16.2 (the dotenv parser Docker Compose v2 uses):
 *
 * - dotenv/parser.go `extractVarValue`: inside either quote, a `\` before the
 *   closing quote character escapes it (the `\` is dropped); a `\` before any
 *   other character is kept together with it. Single-quoted text gets no
 *   further processing: no `$` interpolation, `#` kept.
 * - Double-quoted text then goes through `expandEscapes` (`\\` -> `\`,
 *   `\"` -> `"`, `\$` -> `$$`, `\n` and friends -> control characters) and
 *   template.go `Substitute` (`$$` -> `$`, `$NAME`/`${…}` interpolated).
 *
 * So a value with neither `'` nor `\` is written single-quoted, literally.
 * Any other value is double-quoted with `\` -> `\\`, `"` -> `\"` and
 * `$` -> `$$`. A `\` forces double quotes because a single-quoted value
 * ending in an odd run of `\` would escape its own closing quote
 * (`A='x\'` is unterminated). Values never contain line breaks or NUL
 * (`variableValueSchema`).
 */
function quoteValue(value: string): string {
  if (!value.includes("'") && !value.includes("\\")) return `'${value}'`;
  const escaped = value.replace(/[\\"$]/g, (c) =>
    c === "$" ? "$$" : `\\${c}`
  );
  return `"${escaped}"`;
}

/**
 * Renders an environment's `.env`: the header, the variables sorted by name,
 * `DOCKER_REGISTRY=<registry>`, then the tag variables sorted by name. The
 * registry is the deploy registry; the Panel writes it because `DOCKER_` names
 * are reserved for user variables while every compose file pulls
 * `${DOCKER_REGISTRY}/…`. Registry and tag lines stay unquoted (the form the
 * deploy script greps and `sed`s); both are validated to characters that need
 * no quoting. Throws on an invalid name, value, tag or registry, a duplicate
 * name, or a variable named like a tag variable.
 */
export function renderEnvFile(
  vars: { name: string; value: string }[],
  tags: Record<string, string>,
  registry: string
): string {
  const tagNames = Object.keys(tags).sort();
  const nameSchema = variableNameSchema(tagNames);
  const seen = new Set<string>();
  for (const { name, value } of vars) {
    nameSchema.parse(name);
    variableValueSchema.parse(value);
    if (seen.has(name)) throw new Error(`Duplicate variable ${name}`);
    seen.add(name);
  }

  const lines = [ENV_FILE_HEADER];
  const sorted = [...vars].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  for (const { name, value } of sorted) {
    lines.push(`${name}=${quoteValue(value)}`);
  }
  lines.push(`DOCKER_REGISTRY=${deployRegistrySchema.parse(registry)}`);
  for (const name of tagNames) {
    envVarNameSchema.parse(name);
    lines.push(`${name}=${deployTagSchema.parse(tags[name])}`);
  }
  return `${lines.join("\n")}\n`;
}

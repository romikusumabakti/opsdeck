/** The URL-name base an environment name gives (`uniqueEnvSlug` adds -2, -3 on collision). */
export function baseEnvSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "env"
  );
}

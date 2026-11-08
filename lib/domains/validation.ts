import { z } from "zod";

// One flat DNS label under a registered zone. Cloudflare's free Universal SSL
// covers only one level (`hris-staging.dssconsulting.id`), so a dotted label is
// refused. Lowercase only: callers normalise before parsing.
export const DOMAIN_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const domainLabelSchema = z
  .string()
  .regex(
    DOMAIN_LABEL_PATTERN,
    "Use one label of lowercase letters, digits and hyphens, not starting or ending with a hyphen"
  );

const HOSTNAME_MAX_LENGTH = 253;

/** `<label>.<zone>`, for a zone row's `name` (the apex domain). */
export function hostnameFor(label: string, zoneName: string): string {
  return `${label}.${zoneName.toLowerCase()}`;
}

/** The address an environment opens at through its domain's hostname. */
export function domainUrl(hostname: string): string {
  return `https://${hostname}`;
}

/** An FQDN: at least two labels, each valid, 253 characters at most. */
export function isFqdn(hostname: string): boolean {
  if (hostname.length > HOSTNAME_MAX_LENGTH) return false;
  const labels = hostname.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))
  );
}

// Trimmed and lowercased first, so `Example.COM` is stored as `example.com`.
export const externalHostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isFqdn, "Enter a full domain name such as app.example.com");

// Where cloudflared reaches the entry port from: a host name or IPv4 address,
// no scheme, port or path.
export const originHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(HOSTNAME_MAX_LENGTH)
  .regex(
    /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/,
    "Enter a host name or IP address without scheme or port"
  );

export const entryPortSchema = z.number().int().min(1).max(65535);

export const domainInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tunnel"),
      zoneId: z.uuid(),
      label: domainLabelSchema,
      // null = public, which needs org server:manage.
      accessPolicyId: z.string().trim().min(1).max(255).nullable(),
      entryPort: entryPortSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      hostname: externalHostnameSchema,
    })
    .strict(),
]);

export type DomainInput = z.infer<typeof domainInputSchema>;

/**
 * Whether a reusable Access policy lets anyone in: a bypass decision or an
 * `everyone` include rule. Such a policy is a public binding in effect.
 */
export function isPublicPolicy(policy: {
  decision: string;
  everyone: boolean;
}): boolean {
  return policy.decision === "bypass" || policy.everyone;
}

/** Whether the hostname is a registered zone or a name under one. */
export function isUnderZone(hostname: string, zoneNames: string[]): boolean {
  return zoneNames.some((zone) => {
    const name = zone.toLowerCase();
    return hostname === name || hostname.endsWith(`.${name}`);
  });
}

// Messages of the domain APIs' 4xx answers. The UI matches the message to its
// own translated text (ApiError carries only status and message), so the
// messages live here, keyed by a stable code, and are shared by both sides.

export const DOMAIN_ERRORS = {
  cloudflareNotConfigured: "The Cloudflare account is not set up",
  tunnelUnknown: "The Cloudflare account has no tunnel with this id",
  tunnelNotRemote:
    "Only remotely-managed tunnels can be registered: this tunnel is configured locally",
  tunnelServerTaken: "This server already has a registered tunnel",
  tunnelAlreadyRegistered: "This tunnel is already registered for a server",
  tunnelBound: "Environments still use this tunnel",
  serverUnknown: "Server not found",
  domainNoTargets: "The environment has no deploy targets",
  domainMultiServer: "The environment deploys to more than one server",
  domainNoTunnel: "The deploy server has no registered tunnel",
  domainUnknownZone: "The zone is not registered",
  domainUnknownPolicy: "The Access policy does not exist in the account",
  domainExternalInZone:
    "This hostname is under a registered zone: use the Cloudflare tunnel type",
  domainHostnameTaken: "Another environment uses this hostname",
  domainProvisioned:
    "The domain is already provisioned and cannot be changed yet",
  domainPublicForbidden: "Only an admin can publish without Access",
} as const;

export type DomainErrorCode = keyof typeof DOMAIN_ERRORS;

/** The code of a known message, else null. */
export function domainErrorCode(message: string): DomainErrorCode | null {
  for (const code of Object.keys(DOMAIN_ERRORS) as DomainErrorCode[]) {
    if (DOMAIN_ERRORS[code] === message) return code;
  }
  return null;
}

/** The Postgres error code of a failed query, also when wrapped by drizzle. */
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

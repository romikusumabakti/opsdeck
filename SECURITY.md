# Security

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
this repository. Don't open a public issue. You'll get a reply within a few
working days. Fixes ship as a normal release, and installed instances pick it
up through the updater.

Only the latest release is supported.

## Threat model

An OpsDeck instance holds the keys to the servers it manages: SSH private keys
and passwords, database admin passwords, Cloudflare API tokens, CI and forge
tokens, and S3 credentials. Whoever controls the instance controls that
fleet. Treat it like a bastion host, and treat its database and backups like a
password vault.

What the design defends against:

- **A stolen database or backup.** Secrets are encrypted at rest with
  AES-256-GCM under `SECRETS_KEY` (`lib/secrets.ts`). Backups never contain
  that key, and a restore refuses to run without it. Keep it offline, apart
  from the backups.
- **The network in front of the panel.** Caddy listens on `127.0.0.1` only and
  serves plain HTTP. TLS terminates at a tunnel (e.g. cloudflared) or a reverse
  proxy you put in front. Postgres, Valkey, Garage and imgproxy publish no
  host ports.
- **Users exceeding their role.** Roles are defined in code
  (`lib/permissions.ts`) and checked on the server for every route. The server
  terminal and the file explorers need an explicit grant (admin, infra, or the
  engineer job role). Stored credentials (SSH keys, passwords, API tokens)
  never reach the browser; a secret variable is shown only on an explicit
  reveal, which is logged.
- **Forged CI notifications.** Build notifications are HMAC-SHA256 signed with
  a per-component secret and compared in constant time.
- **Terminal hijacking.** The browser terminal runs in a separate sidecar. It
  accepts only a single-use ticket minted by the app and valid for 30 seconds,
  checks the WebSocket `Origin`, and caps sessions per user, idle time (30 min)
  and total lifetime (8 h).
- **A stolen password.** Risky actions need a strong sign-in: a passkey,
  Microsoft Entra ID, or email + password plus a TOTP code. The session
  records how it was created. Without a strong sign-in the server refuses
  (403 `strong_sign_in_required`) the terminal, the file explorers, revealing
  secret variables, and every org action outside a short allowlist, as well as
  better-auth's `/admin/*` endpoints. These stay available with a password
  alone: reading servers, storage and tunnels, listing users, the knowledge
  base, reading the activity log, and creating projects. Org actions added
  later need a strong sign-in by default. Sessions that existed before the
  upgrade have no recorded method and count as weak, so users sign in again
  once. A banner tells a weak session that it is limited. Entra is trusted as
  is: the tenant's Conditional Access must enforce MFA, and OpsDeck does not
  check the `amr` claim. TOTP secrets and backup codes are encrypted with
  `BETTER_AUTH_SECRET`. An admin can reset another user's two-factor (never
  their own); this revokes that user's sessions and is logged.
- **Cross-site attacks.** Cookie sessions with an `Origin` check on mutating
  requests, `nosniff`, a strict referrer policy and a Content-Security-Policy
  (`script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'`). Inline scripts don't run, so the theme script is
  a static file (`public/theme-init.js`) and the client runs Zod without JIT.

What it does not defend against:

- **Code execution inside the app container.** The app holds `SECRETS_KEY` in
  memory to decrypt secrets, so an attacker who runs code there can read every
  secret. Keep the host patched and limit who can `docker exec`.
- **A malicious admin.** Admins can read and change everything the panel
  manages. The activity log records who did what, but it lives in the same
  database.

## Audit trail

The activity log (Admin → Activity) records changes to environments,
variables (including every reveal of a secret value), deploys and deploy
locks, project members and users, servers, tunnels and connections, file
explorer actions, and terminal sessions (`terminal.open`, `terminal.close`
with duration and reason, and `terminal.denied` for rejected tickets). It
records neither sign-ins nor what is typed in a terminal session.

## Supply chain

Each release publishes:

- a multi-arch image on GHCR with SLSA build provenance, referenced by digest
  in the installer's `compose.yaml`;
- `release.json`, which pins every installer asset and image by sha256;
- build provenance for `release.json` and every installer asset.

Verify a download against this repository's release workflow:

```sh
gh attestation verify install.sh -R romikusumabakti/opsdeck
gh attestation verify release.json -R romikusumabakti/opsdeck
gh attestation verify oci://ghcr.io/romikusumabakti/opsdeck:<version> -R romikusumabakti/opsdeck
```

GitHub Actions are pinned by commit SHA, and the release workflow runs
with least-privilege `permissions`.

## Known gaps

- A password-only session can turn on TOTP for its own account, so a stolen
  password plus an account that has not enrolled is still enough. The
  enrollment is logged.
- Microsoft OAuth tokens are stored as better-auth stores them, unencrypted.
- Knowledge-base pages are stored as written. Don't paste credentials into
  them; put them in secret variables, which are encrypted.

# SSH keys and host key verification for servers — design

Status: draft for Romi's review (2026-11-09). Project 3 of 4 in the Panel program.

## Why

The Panel reaches every server as `root` with a stored password: command runs, deploys, provisioning, the web terminal and the file explorer.
- All 28 servers in the DSS Panel are like this today (checked 2026-11-09).
- No host key is verified anywhere (`lib/ssh.ts`, `lib/terminal/ssh-shell.ts`, `lib/explorer/sftp*.ts` use node-ssh / ssh2 with `password` and no `hostVerifier`). A machine that answers on a server's address would receive the root password.
- Since project 1, engineers deploy to servers themselves, so the gap matters more.

Opsdeck is also a product (project 2), so the design must work on any install, not only DSS.

## Decisions made with Romi (2026-11-09)

1. **One SSH key per Panel instance.** It is an ed25519 keypair, installed on every server and rotatable with one action.
2. **Passwords are deleted** from the Panel once key login to that server is verified. Recovery uses the estate root password, kept offline (`~/.config/secrets/dss/estate-root-password` for DSS).
3. **The key is IP-restricted.** Each `authorized_keys` line gets `from="<source address>"`, detected automatically at install time from the server's view of the Panel's connection (`$SSH_CLIENT`).
4. **Rollout:** a canary on DSS .56.113 first, then one "Move all servers to the SSH key" action with a per-server report. A server that fails stays on its password and shows why.

## Model

- **Instance key:**
  - The Panel generates one ed25519 keypair on first need (boot or first use).
  - The private key is stored encrypted with `lib/secrets.ts` (`SECRETS_KEY`) and never leaves the server side.
  - The public key and its SHA256 fingerprint are readable by admins.
  - Rotation keeps two keys for a while (`current`, `previous`), so a new table `ssh_keys` makes sense *(Claude's call)*: id, public key, encrypted private key, fingerprint, created_at, status `current|previous|retired`.
- **Servers gain:**
  - `auth`: `password` or `key`;
  - the pinned host key (algorithm + base64 blob) and its SHA256 fingerprint;
  - `host_key_pinned_at`;
  - the key id installed;
  - the `from` address used;
  - the last key-migration error (stable code).
  - `password` stays nullable and is cleared after migration.
- **Host key verification on every connection** (commands, deploys, provisioning, terminal, SFTP, preflight, test):
  - The ssh2 `hostVerifier` compares the offered key with the pin.
  - **No pin yet:** trust on first use. Pin the key, and record who and when in the activity log.
  - **Mismatch:** refuse with code `hostKeyMismatch`. No command, password or key auth is attempted. The server page shows the old and new fingerprints, and an admin (`server:manage`) can re-trust after checking out of band.
  - **Shared code:** there is one connection factory for all callers, so no path can skip verification.

## Flows

### Move a server to the key (one server, or all)

1. Connect with the stored password. The host key is verified, or pinned when this is the first connection.
2. Read the source address the server sees (`$SSH_CLIENT`'s first field).
3. Append the line to `~/.ssh/authorized_keys` idempotently:
   ```
   from="<addr>",no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA… opsdeck:<instance>:<key-id>
   ```
   - Create `~/.ssh` (0700) and the file (0600) if missing, and keep their owner and mode.
   - Never touch other lines: the estate already has `romi@bluefin-romi` and `anggi@bluefin-anggi` keys.
   - A line that carries the same marker is replaced.
4. Open a fresh connection with the key only (no password offered), with host verification, and run `true`.
5. On success, set `auth=key`, clear the stored password, and record activity `server.keyInstalled`. On failure, remove the line just added, keep the password, and store the error code (`keyInstallFailed`, `keyLoginFailed`, `hostKeyMismatch`, `unreachable`).

**Source address edge cases:**
- **The Panel's own host.** Containers reach the host from the Docker bridge, so `$SSH_CLIENT` is a container address that changes with recreates. Use the compose network's subnet in CIDR form, e.g. `from="172.29.0.0/16"`. The Panel knows its own network from its container. *(Claude's call.)*
  - **Verified on .113 (2026-11-09):** an SSH attempt from `opsdeck-app-1` to 192.168.56.113 is logged by sshd as coming from `172.29.0.7`, the container's address in `opsdeck_default` (subnet `172.29.0.0/16`).
- **NAT.** Servers behind or across NAT see the NAT address. The VPS sees the office public IP. The restriction then follows that IP, and the server page says so. If the office IP changes, key login fails with `keyLoginFailed`, and recovery uses the offline password.

**"Move all servers":**
- Runs sequentially as one job with a progress view and a final table: server, result, code.
- The canary is just this action on one server.

### Add a new server

There are two choices on the new-server form, and the key is the default:
- **Install the key yourself.** The page shows the public key and a one-line command with the `from=` filled in. The Panel's source address as the server will see it can only be guessed before connecting, so it is editable.
- **Enter the root password once.** The Panel runs the move flow immediately and never stores the password.

### Rotate the key

An admin action:
1. Generate a new key.
2. For every `auth=key` server, connect with the current key, add the new line, verify login with the new key, then remove the old line.
3. Mark the old key `previous` until every server is done, then `retired`.
4. Servers that fail keep the old line and are listed.

### Non-root logins *(Claude's call)*
- Today the stored password doubles as the **sudo password** (`printf '<password>' | sudo -S …` in `lib/jobs/commands.ts`, `server/services/databases.ts`, `server/services/backups.ts`).
- A server may move to the key only when the login is `root`, or when `sudo -n true` succeeds (NOPASSWD sudo). Otherwise the move is refused with `sudoNeedsPassword` and the server keeps its password.
- All 28 DSS servers log in as `root` (checked 2026-11-09).
- For key servers, the sudo plumbing is not used: root runs commands directly, and NOPASSWD sudo users run `sudo -n`.

### Recovery when key login fails *(Claude's call)*
- A key server whose login fails (e.g. the office public IP changed, so `from=` no longer matches) shows `keyLoginFailed`.
- An admin uses **"Reinstall key"**: they enter the root password once, the Panel connects with it, rewrites its `authorized_keys` line with the current `from=` address, verifies key login, and discards the password. The password is never stored. This keeps decision 2 strict.

### Host key change during a run *(Claude's call)*
- A mismatch fails the step that hit it with code `hostKeyMismatch`, so the run fails like any other step failure. The server is flagged, and every new connection to it is refused until an admin trusts the new key.
- No job-level quarantine state is added.
- A trust-on-first-use pin made by a background job is recorded with actor "system" and the run that made it.

## UI (simple by default)

- **Servers list:** a column "Access" showing Key (with fingerprint tooltip), Password, or a host-key warning.
- **Server page:**
  - access status, host key fingerprint and pin date, the `from` address;
  - a "Move to SSH key" button;
  - on a host key mismatch, a red banner with both fingerprints and "Trust new key" (`server:manage`).
  - The password field is shown only while `auth=password`, under Advanced options.
- **Admin → Instance:** an "SSH key" card with the public key, fingerprint, "Move all servers to the SSH key" and "Rotate".

## Constraints

- **Security:**
  - The private key and passwords are never sent to the browser, never logged and never in argv.
  - Host verification is mandatory on all paths.
  - Moves and rotation require org `server:manage`.
  - Error bodies carry stable codes, with messages in all 5 locales.
- **Stack:**
  - ssh2 / node-ssh as today, using ed25519 key generation via `ssh2`'s `utils.generateKeyPairSync('ed25519')` or Node `crypto`.
  - Drizzle migration under the migrator rules (expand only: add columns and the table, keep `password` nullable).
- **Backups:** backups already contain the encrypted private key (it is in the DB). A restore needs `SECRETS_KEY`, as for every other secret.

## Goals, non-goals, anti-goals

- **Goals:**
  - every DSS server reached by key with a pinned host key;
  - no stored root passwords;
  - new servers added without storing a password.
- **Non-goals:**
  - non-root service users (still root);
  - SSH certificates or a CA;
  - Proxmox nodes (not managed by the Panel);
  - removing the estate keys of Romi and Anggi.
- **Anti-goals:**
  - locking the Panel out of a server with no way back (the password stays until key login is proven);
  - silently accepting a changed host key.

## Left to the builder

- **Storage and code shape:** exact column names, the job and progress transport (reuse runs/BullMQ), and how the connection factory is shared between the app and the terminal sidecar.
- **Terminal and SFTP pools:** the sidecar and the SFTP pool must load the key and pins through the same module.

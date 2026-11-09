import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";

// The ops/install scripts run under a PATH that holds only the test's stubs
// and the plain tools below, linked from the host. Everything the scripts
// probe about the host (docker, docker compose, dpkg, dpkg-query, systemctl,
// apt-get, id, uname, curl, ...) is left out on purpose: a test that needs
// one provides a stub, so the result never depends on what the machine
// running the tests has installed (a CI runner has a real Docker and dpkg; a
// laptop may have neither).
const SCRIPT_TOOLS = [
  "sh",
  "awk",
  "base64",
  "basename",
  "cat",
  "chmod",
  "chown",
  "cp",
  "cut",
  "date",
  "dd",
  "dirname",
  "env",
  "find",
  "flock",
  "grep",
  "head",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "od",
  "openssl",
  "readlink",
  "rm",
  "sed",
  "sha256sum",
  "sleep",
  "sort",
  "stat",
  "tail",
  "tee",
  "touch",
  "tr",
  "uniq",
  "wc",
  "xargs",
];

function which(tool: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, tool);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return undefined;
}

// Resolved on first use. A tool this host lacks is left out: a script that
// needs it then fails with "not found" in the test that uses it.
let resolved: [string, string][] | undefined;

/** Links the plain host tools into <dir> (created) and returns it, for PATH. */
export function hostTools(dir: string) {
  resolved ??= SCRIPT_TOOLS.flatMap((tool) => {
    const path = which(tool);
    return path ? [[tool, path] as [string, string]] : [];
  });
  mkdirSync(dir, { recursive: true });
  for (const [tool, path] of resolved) symlinkSync(path, join(dir, tool));
  return dir;
}

/**
 * Whether a lint tool (shellcheck, actionlint) is installed; its test is
 * skipped without it, except in CI, where the workflow installs a pinned
 * version, so a missing one is an error there.
 */
export function lintToolAvailable(tool: string) {
  if (spawnSync(tool, ["--version"]).status === 0) return true;
  if (process.env.CI) throw new Error(`${tool} is missing in CI`);
  return false;
}

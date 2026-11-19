import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RemoteCommandError } from "@/lib/remote-command-error";
import { shq } from "@/lib/sh";
import { HostKeyMismatchError } from "@/lib/ssh-connect";

// readEnvironmentEnvFiles: one read per (server, deploy dir) of the compose
// targets, each mapped to a fixed status. No .env text reaches a log line,
// an error or the returned rows' non-text fields.

process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

const ENV_ID = "env-1";
const SECRET = "FAKE_SECRET_VALUE_7f3a";

type FakeTarget = {
  id: string;
  kind: "compose" | "jar" | "static";
  serverId: string;
  deployDir: string;
};

type RemoteResult = { code: number | null; stdout: string; stderr: string };

const state = vi.hoisted(() => ({
  targets: [] as FakeTarget[],
  servers: [] as { id: string; name: string }[],
  missingCredentials: new Set<string>(),
  // deploy dir → what the fake remote does
  remote: new Map<string, () => Promise<RemoteResult>>(),
  calls: [] as { host: string; command: string; options: unknown }[],
}));

vi.mock("@/lib/deploy/repository", () => ({
  listTargetsForEnvironment: vi.fn(async () => state.targets),
}));

vi.mock("@/lib/environments", () => ({
  loadServerCredentials: vi.fn(async (serverId: string) =>
    state.missingCredentials.has(serverId)
      ? null
      : {
          serverId,
          host: `${serverId}.example.test`,
          username: "ops",
          password: "pw",
          auth: "password",
        }
  ),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      servers: {
        findMany: vi.fn(async () => state.servers),
      },
    },
  },
}));

vi.mock("@/lib/ssh", () => ({
  runRemoteScript: vi.fn(
    async (target: { host: string }, command: string, options: unknown) => {
      state.calls.push({ host: target.host, command, options });
      for (const [dir, run] of state.remote) {
        if (command.includes(dir)) return run();
      }
      throw new Error("no fake for this dir");
    }
  ),
}));

const { readEnvironmentEnvFiles, envFingerprint, serverEnvReadScript } =
  await import("@/lib/variables/server-env");

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const res = (stdout: string, code: number | null = 0, stderr = "") =>
  Promise.resolve({ code, stdout, stderr });
const ok = (text: string, override = false) =>
  res(`OK ${override ? 1 : 0}\n${b64(text)}\nEND`);

function target(
  id: string,
  serverId: string,
  deployDir: string,
  kind: FakeTarget["kind"] = "compose"
): FakeTarget {
  return { id, kind, serverId, deployDir };
}

let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  state.targets = [];
  state.servers = [
    { id: "s1", name: "app-one" },
    { id: "s2", name: "app-two" },
  ];
  state.missingCredentials.clear();
  state.remote.clear();
  state.calls.length = 0;
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {})
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

function consoleOutput(): string {
  return JSON.stringify(spies.map((s) => s.mock.calls));
}

describe("readEnvironmentEnvFiles", () => {
  it("reads one dir per (server, deploy dir) and skips non-compose targets", async () => {
    state.targets = [
      target("t1", "s1", "/srv/app"),
      target("t2", "s1", "/srv/app"),
      target("t3", "s2", "/srv/app"),
      target("t4", "s1", "/srv/jar", "jar"),
      target("t5", "s1", "/srv/static", "static"),
    ];
    state.remote.set("/srv/app", () => ok("A=1\n"));

    const rows = await readEnvironmentEnvFiles(ENV_ID);

    expect(state.calls).toHaveLength(2);
    expect(state.calls.map((c) => c.host).sort()).toEqual([
      "s1.example.test",
      "s2.example.test",
    ]);
    expect(
      rows.map((r) => [r.serverId, r.serverName, r.deployDir, r.status])
    ).toEqual([
      ["s1", "app-one", "/srv/app", "ok"],
      ["s2", "app-two", "/srv/app", "ok"],
    ]);
  });

  it("runs the read script under sh -c with the 10 s timeout", async () => {
    state.targets = [target("t1", "s1", "/srv/app")];
    state.remote.set("/srv/app", () => ok("A=1\n"));
    await readEnvironmentEnvFiles(ENV_ID);
    expect(state.calls[0]?.command).toBe(
      `sh -c ${shq(serverEnvReadScript("/srv/app"))}`
    );
    expect(state.calls[0]?.options).toEqual({ timeoutMs: 10_000 });
  });

  it("returns the text, the override flag and a fingerprint for an ok read", async () => {
    const text = 'A=1\nB="two words"\n';
    state.targets = [target("t1", "s1", "/srv/app")];
    state.remote.set("/srv/app", () => ok(text, true));

    const [row] = await readEnvironmentEnvFiles(ENV_ID);

    expect(row).toMatchObject({
      status: "ok",
      overridePresent: true,
      text,
      fingerprint: envFingerprint(text),
    });
  });

  it("reads an empty file as ok with no entries", async () => {
    state.targets = [target("t1", "s1", "/srv/app")];
    state.remote.set("/srv/app", () => res("OK 0\nEND"));
    const [row] = await readEnvironmentEnvFiles(ENV_ID);
    expect(row).toMatchObject({ status: "ok", text: "" });
  });

  it("an OK line with no END (stderr, failed pipeline) is not ok", async () => {
    state.targets = [
      target("t1", "s1", "/srv/a"),
      target("t2", "s1", "/srv/b"),
      target("t3", "s1", "/srv/c"),
    ];
    // No body, an error on stderr, exit 0 (an old script without END).
    state.remote.set("/srv/a", () =>
      res("OK 0", 0, "head: .env: Input/output error")
    );
    // A truncated body: head failed mid-read, the script exits 5.
    state.remote.set("/srv/b", () => res(`OK 0\n${b64("A=1\nB=tw")}`, 5));
    // END but a body that is not whole base64.
    state.remote.set("/srv/c", () => res("OK 0\nQT0x*\nEND"));
    const rows = await readEnvironmentEnvFiles(ENV_ID);
    expect(rows.map((r) => r.status)).toEqual([
      "unreachable",
      "unreachable",
      "unreachable",
    ]);
    for (const row of rows) expect(row.text).toBeUndefined();
  });

  it("a server without base64 (exit 4) is unreachable", async () => {
    state.targets = [target("t1", "s1", "/srv/app")];
    state.remote.set("/srv/app", () => res("", 4));
    const [row] = await readEnvironmentEnvFiles(ENV_ID);
    expect(row?.status).toBe("unreachable");
  });

  it("keeps non-ASCII bytes exact (base64 transport)", async () => {
    const text = "GREETING=héllo wörld ✓\n";
    state.targets = [target("t1", "s1", "/srv/app")];
    state.remote.set("/srv/app", () => ok(text));
    const [row] = await readEnvironmentEnvFiles(ENV_ID);
    expect(row?.text).toBe(text);
  });

  it("maps the remote status lines", async () => {
    state.targets = [
      target("t1", "s1", "/srv/a"),
      target("t2", "s1", "/srv/b"),
      target("t3", "s1", "/srv/c"),
    ];
    state.remote.set("/srv/a", () => res("DIR_MISSING"));
    state.remote.set("/srv/b", () => res("FILE_MISSING"));
    state.remote.set("/srv/c", () => res("TOO_LARGE"));

    const rows = await readEnvironmentEnvFiles(ENV_ID);

    expect(rows.map((r) => [r.deployDir, r.status])).toEqual([
      ["/srv/a", "dirMissing"],
      ["/srv/b", "fileMissing"],
      ["/srv/c", "tooLarge"],
    ]);
    for (const row of rows) {
      expect(row.text).toBeUndefined();
      expect(row.fingerprint).toBeUndefined();
    }
  });

  it("treats more than 256 KiB read as tooLarge", async () => {
    state.targets = [target("t1", "s1", "/srv/app")];
    state.remote.set("/srv/app", () => ok(`A=${"x".repeat(262_144)}`));
    const [row] = await readEnvironmentEnvFiles(ENV_ID);
    expect(row?.status).toBe("tooLarge");
    expect(row?.text).toBeUndefined();
  });

  it("reports a parse error with its line only", async () => {
    state.targets = [target("t1", "s1", "/srv/app")];
    state.remote.set("/srv/app", () => ok(`A=1\nB="${SECRET}\n`));

    const [row] = await readEnvironmentEnvFiles(ENV_ID);

    expect(row?.status).toBe("parseError");
    expect(row?.line).toBe(2);
    expect(row?.text).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it("maps a host key mismatch", async () => {
    state.targets = [target("t1", "s1", "/srv/app")];
    state.remote.set("/srv/app", () =>
      Promise.reject(new HostKeyMismatchError("SHA256:new", "SHA256:old"))
    );
    const [row] = await readEnvironmentEnvFiles(ENV_ID);
    expect(row?.status).toBe("hostKeyMismatch");
  });

  it("maps a timeout, a connect failure and missing credentials to unreachable", async () => {
    state.targets = [
      target("t1", "s1", "/srv/a"),
      target("t2", "s1", "/srv/b"),
      target("t3", "s2", "/srv/c"),
    ];
    state.missingCredentials.add("s2");
    state.remote.set("/srv/a", () =>
      Promise.reject(new Error("SSH command timed out after 10000ms"))
    );
    state.remote.set("/srv/b", () =>
      Promise.reject(new Error("connect ECONNREFUSED"))
    );

    const rows = await readEnvironmentEnvFiles(ENV_ID);

    expect(rows.map((r) => r.status)).toEqual([
      "unreachable",
      "unreachable",
      "unreachable",
    ]);
  });

  it("never logs or returns the text of a failing read", async () => {
    state.targets = [
      target("t1", "s1", "/srv/a"),
      target("t2", "s1", "/srv/b"),
      target("t3", "s1", "/srv/c"),
    ];
    state.remote.set("/srv/a", () =>
      res(
        `OK 0\n${b64(`DB_PASSWORD=${SECRET}`)}\nDB_PASSWORD=${SECRET}`,
        5,
        SECRET
      )
    );
    state.remote.set("/srv/b", () =>
      Promise.reject(new RemoteCommandError(1, `DB_PASSWORD=${SECRET}`, SECRET))
    );
    state.remote.set("/srv/c", () => res(`GARBAGE ${SECRET}`));

    const rows = await readEnvironmentEnvFiles(ENV_ID);

    expect(rows.map((r) => r.status)).toEqual([
      "unreachable",
      "unreachable",
      "unreachable",
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(consoleOutput()).not.toContain(SECRET);
  });

  it("one failing dir does not fail the others", async () => {
    state.targets = [
      target("t1", "s1", "/srv/a"),
      target("t2", "s1", "/srv/b"),
    ];
    state.remote.set("/srv/a", () => res("", 255, "boom"));
    state.remote.set("/srv/b", () => ok("A=1\n"));
    const rows = await readEnvironmentEnvFiles(ENV_ID);
    expect(rows.map((r) => r.status)).toEqual(["unreachable", "ok"]);
  });

  it("shell-quotes the deploy dir", async () => {
    const dir = "/srv/it's $(touch pwned)";
    state.targets = [target("t1", "s1", dir)];
    state.remote.set("touch pwned", () => ok("A=1\n"));
    await readEnvironmentEnvFiles(ENV_ID);
    expect(serverEnvReadScript(dir)).toContain(
      `cd -- '/srv/it'\\''s $(touch pwned)'`
    );
    expect(state.calls[0]?.command).toBe(
      `sh -c ${shq(serverEnvReadScript(dir))}`
    );
  });

  it("returns nothing for an environment without compose targets", async () => {
    state.targets = [target("t1", "s1", "/srv/jar", "jar")];
    await expect(readEnvironmentEnvFiles(ENV_ID)).resolves.toEqual([]);
    expect(state.calls).toHaveLength(0);
  });
});

describe("envFingerprint", () => {
  it("hashes the raw bytes: a string is its UTF-8 bytes", () => {
    const text = "A=héllo\n";
    expect(envFingerprint(Buffer.from(text, "utf8"))).toBe(
      envFingerprint(text)
    );
  });

  it("is stable, distinguishes texts and is not a plain hash", () => {
    expect(envFingerprint("A=1\n")).toBe(envFingerprint("A=1\n"));
    expect(envFingerprint("A=1\n")).not.toBe(envFingerprint("A=2\n"));
    const plain = createHash("sha256").update("A=1\n").digest();
    expect(envFingerprint("A=1\n")).not.toBe(plain.toString("hex"));
    expect(envFingerprint("A=1\n")).not.toBe(plain.toString("base64url"));
  });

  it("is keyed by SECRETS_KEY", async () => {
    const before = envFingerprint("A=1\n");
    const original = process.env.SECRETS_KEY;
    process.env.SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");
    vi.resetModules();
    try {
      const fresh = await import("@/lib/variables/server-env");
      expect(fresh.envFingerprint("A=1\n")).not.toBe(before);
    } finally {
      process.env.SECRETS_KEY = original;
      vi.resetModules();
    }
  });
});

// The real script under the local POSIX sh, against temp dirs.
describe("serverEnvReadScript under sh", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "server-env-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function dir(name: string, files: Record<string, string | Buffer> = {}) {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(path, file), content);
    }
    return path;
  }

  function run(deployDir: string, env: NodeJS.ProcessEnv = process.env) {
    const out = spawnSync("/bin/sh", ["-c", serverEnvReadScript(deployDir)], {
      encoding: "utf8",
      env,
    });
    return { code: out.status, stdout: out.stdout.trim(), stderr: out.stderr };
  }

  it("prints DIR_MISSING for a missing dir", () => {
    expect(run(join(root, "nope"))).toEqual({
      code: 0,
      stdout: "DIR_MISSING",
      stderr: "",
    });
  });

  it("prints FILE_MISSING without a .env", () => {
    expect(run(dir("empty")).stdout).toBe("FILE_MISSING");
  });

  it("exits 4, not TOO_LARGE, when wc is broken", () => {
    const bin = join(root, "broken-bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["head", "base64", "tr"]) {
      symlinkSync(
        execFileSync("which", [tool]).toString().trim(),
        join(bin, tool)
      );
    }
    writeFileSync(join(bin, "wc"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const path = dir("wc-broken", { ".env": "A=1\n" });
    const out = run(path, { ...process.env, PATH: bin });
    expect(out.code).toBe(4);
    expect(out.stdout).not.toContain("TOO_LARGE");
  });

  it("prints TOO_LARGE over 256 KiB", () => {
    const path = dir("large", { ".env": `A=${"x".repeat(262_144)}` });
    expect(run(path)).toMatchObject({ code: 0, stdout: "TOO_LARGE" });
  });

  it("prints OK 0, the base64 body and END", () => {
    const text = 'A=1\nB="héllo"\n';
    const path = dir("plain", { ".env": text });
    const { code, stdout } = run(path);
    expect(code).toBe(0);
    const lines = stdout.split("\n");
    expect(lines[0]).toBe("OK 0");
    expect(lines.at(-1)).toBe("END");
    expect(Buffer.from(lines.slice(1, -1).join(""), "base64").toString()).toBe(
      text
    );
  });

  it("prints OK 1 next to a compose.override.yaml", () => {
    const path = dir("override", {
      ".env": "A=1\n",
      "compose.override.yaml": "services: {}\n",
    });
    expect(run(path).stdout.split("\n")[0]).toBe("OK 1");
  });

  it("handles a quote and $(…) in the dir name literally", () => {
    const path = dir("it's $(echo x)", { ".env": "A=1\n" });
    expect(run(path).stdout.split("\n")[0]).toBe("OK 0");
  });

  it("exits 3 for a .env that is a directory", () => {
    const path = dir("dir-env");
    mkdirSync(join(path, ".env"));
    expect(run(path)).toMatchObject({ code: 3, stdout: "" });
  });

  it("exits 4 without base64 on PATH", () => {
    const path = dir("no-base64", { ".env": "A=1\n" });
    const bin = dir("bin-without-base64");
    for (const tool of ["head", "wc", "tr"]) {
      const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], {
        encoding: "utf8",
      }).stdout.trim();
      symlinkSync(found, join(bin, tool));
    }
    expect(run(path, { PATH: bin })).toMatchObject({ code: 4, stdout: "" });
  });
});

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteCommandError } from "@/lib/remote-command-error";
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

const state = vi.hoisted(() => ({
  targets: [] as FakeTarget[],
  servers: [] as { id: string; name: string }[],
  missingCredentials: new Set<string>(),
  // deploy dir → what the fake remote does
  remote: new Map<string, () => Promise<string>>(),
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
  executeRemoteCommand: vi.fn(
    async (target: { host: string }, command: string, options: unknown) => {
      state.calls.push({ host: target.host, command, options });
      for (const [dir, run] of state.remote) {
        if (command.includes(dir)) return run();
      }
      throw new Error("no fake for this dir");
    }
  ),
}));

const { readEnvironmentEnvFiles, envFingerprint } = await import(
  "@/lib/variables/server-env"
);

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const ok = (text: string, override = false) =>
  Promise.resolve(`OK ${override ? 1 : 0}\n${b64(text)}`);

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

  it("passes the 10 s timeout and the no-log option", async () => {
    state.targets = [target("t1", "s1", "/srv/app")];
    state.remote.set("/srv/app", () => ok("A=1\n"));
    await readEnvironmentEnvFiles(ENV_ID);
    expect(state.calls[0]?.options).toMatchObject({
      timeoutMs: 10_000,
      quiet: true,
    });
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
    state.remote.set("/srv/a", async () => "DIR_MISSING");
    state.remote.set("/srv/b", async () => "FILE_MISSING");
    state.remote.set("/srv/c", async () => "TOO_LARGE");

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
      Promise.reject(
        new RemoteCommandError(1, `OK 0\nDB_PASSWORD=${SECRET}`, SECRET)
      )
    );
    state.remote.set("/srv/b", () =>
      Promise.reject(new Error(`unexpected: ${SECRET}`))
    );
    state.remote.set("/srv/c", async () => `GARBAGE ${SECRET}`);

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
    state.remote.set("/srv/a", () =>
      Promise.reject(new RemoteCommandError(255, "", "boom"))
    );
    state.remote.set("/srv/b", () => ok("A=1\n"));
    const rows = await readEnvironmentEnvFiles(ENV_ID);
    expect(rows.map((r) => r.status)).toEqual(["unreachable", "ok"]);
  });

  it("shell-quotes the deploy dir", async () => {
    const dir = "/srv/it's $(touch pwned)";
    state.targets = [target("t1", "s1", dir)];
    state.remote.set("it'\\''s", () => ok("A=1\n"));
    await readEnvironmentEnvFiles(ENV_ID);
    expect(state.calls[0]?.command).toContain(`'/srv/it'\\''s $(touch pwned)'`);
  });

  it("returns nothing for an environment without compose targets", async () => {
    state.targets = [target("t1", "s1", "/srv/jar", "jar")];
    await expect(readEnvironmentEnvFiles(ENV_ID)).resolves.toEqual([]);
    expect(state.calls).toHaveLength(0);
  });
});

describe("envFingerprint", () => {
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

import { describe, expect, it } from "bun:test";
import {
  buildControlCommand,
  buildDbShellCommand,
  buildMysqlCommand,
  buildSqlcmdCommand,
  buildStatusCommand,
  dbAdminUser,
  parseServiceState,
} from "@/lib/services";

describe("parseServiceState", () => {
  describe("docker", () => {
    it("maps 'running' to running", () => {
      expect(parseServiceState("docker", "running\n")).toBe("running");
    });
    it("maps the not-found marker to not-found", () => {
      expect(parseServiceState("docker", "__opsdeck_not_found__")).toBe(
        "not-found"
      );
    });
    it("maps any other status (e.g. exited) to stopped", () => {
      expect(parseServiceState("docker", "exited")).toBe("stopped");
    });
    it("maps empty output to unknown", () => {
      expect(parseServiceState("docker", "   ")).toBe("unknown");
    });
  });

  describe("systemd", () => {
    it("maps active/activating to running", () => {
      expect(parseServiceState("systemd", "active")).toBe("running");
      expect(parseServiceState("systemd", "activating")).toBe("running");
    });
    it("maps inactive/deactivating/failed to stopped", () => {
      expect(parseServiceState("systemd", "inactive")).toBe("stopped");
      expect(parseServiceState("systemd", "deactivating")).toBe("stopped");
      expect(parseServiceState("systemd", "failed")).toBe("stopped");
    });
    it("maps 'unknown' literal to not-found", () => {
      expect(parseServiceState("systemd", "unknown")).toBe("not-found");
    });
    it("maps empty output to unknown", () => {
      expect(parseServiceState("systemd", "")).toBe("unknown");
    });
    it("maps an unrecognized value to unknown", () => {
      expect(parseServiceState("systemd", "reloading")).toBe("unknown");
    });
  });

  describe("kubernetes", () => {
    it("maps the not-found marker to not-found", () => {
      expect(parseServiceState("kubernetes", "__opsdeck_not_found__")).toBe(
        "not-found"
      );
    });
    it("maps desired=0 to stopped", () => {
      expect(parseServiceState("kubernetes", "0 ")).toBe("stopped");
    });
    it("maps desired>=1 with ready>=1 to running", () => {
      expect(parseServiceState("kubernetes", "1 1")).toBe("running");
    });
    it("maps desired>=1 with ready absent/0 to stopped", () => {
      expect(parseServiceState("kubernetes", "1 ")).toBe("stopped");
      expect(parseServiceState("kubernetes", "2 0")).toBe("stopped");
    });
    it("maps non-numeric desired to unknown", () => {
      expect(parseServiceState("kubernetes", "x y")).toBe("unknown");
    });
    it("maps empty output to unknown", () => {
      expect(parseServiceState("kubernetes", "")).toBe("unknown");
    });
  });
});

describe("buildStatusCommand", () => {
  it("quotes the docker service name and tolerates failure", () => {
    const cmd = buildStatusCommand("docker", "my-svc");
    expect(cmd).toContain("docker container inspect");
    expect(cmd).toContain("'my-svc'");
    expect(cmd).toContain("__opsdeck_not_found__");
  });

  it("quotes a name containing a single quote safely", () => {
    // The inner command is itself shq-wrapped, so the service name's single
    // quote ends up doubly escaped — just assert no raw unescaped break-out
    // sequence (`'a'b'`) survives and the marker fallback is still present.
    const cmd = buildStatusCommand("docker", "a'b");
    expect(cmd).not.toContain("inspect -f '{{.State.Status}}' 'a'b'");
    expect(cmd).toContain("__opsdeck_not_found__");
  });

  it("uses kubectl for kubernetes", () => {
    const cmd = buildStatusCommand("kubernetes", "dep");
    expect(cmd).toContain("kubectl get deploy");
    expect(cmd).toContain("'dep'");
  });

  it("uses systemctl is-active for systemd", () => {
    const cmd = buildStatusCommand("systemd", "nginx");
    expect(cmd).toContain("systemctl is-active");
    expect(cmd).toContain("'nginx'");
  });
});

describe("buildControlCommand", () => {
  it("builds a docker control command without sudo", () => {
    expect(buildControlCommand("docker", "svc", "restart", "")).toBe(
      "docker restart 'svc'"
    );
  });

  it("maps kubernetes restart to rollout restart", () => {
    expect(buildControlCommand("kubernetes", "dep", "restart", "")).toBe(
      "kubectl rollout restart deploy 'dep'"
    );
  });

  it("maps kubernetes start/stop to scale", () => {
    expect(buildControlCommand("kubernetes", "dep", "start", "")).toBe(
      "kubectl scale deploy 'dep' --replicas=1"
    );
    expect(buildControlCommand("kubernetes", "dep", "stop", "")).toBe(
      "kubectl scale deploy 'dep' --replicas=0"
    );
  });

  it("feeds the sudo password via stdin for systemd and quotes both args", () => {
    const cmd = buildControlCommand("systemd", "nginx", "start", "p@ss'word");
    expect(cmd).toContain("sudo -S systemctl start 'nginx'");
    // password is shq-quoted (the embedded quote is escaped)
    expect(cmd).toContain("'p@ss'\\''word'");
  });
});

describe("buildDbShellCommand", () => {
  it("wraps the inner pipeline in docker exec ... bash -c", () => {
    const cmd = buildDbShellCommand("docker", "pg", "pg_dump db");
    expect(cmd).toBe("docker exec 'pg' bash -c 'pg_dump db'");
  });

  it("wraps the inner pipeline in kubectl exec for kubernetes", () => {
    const cmd = buildDbShellCommand("kubernetes", "pg", "pg_dump db");
    expect(cmd).toBe("kubectl exec deploy/'pg' -- bash -c 'pg_dump db'");
  });

  it("runs plain bash -c for systemd without runAsUser", () => {
    expect(buildDbShellCommand("systemd", "pg", "pg_dump db")).toBe(
      "bash -c 'pg_dump db'"
    );
  });

  it("uses sudo -u when runAsUser + sudoPassword are provided", () => {
    const cmd = buildDbShellCommand("systemd", "pg", "pg_dump db", {
      runAsUser: "postgres",
      sudoPassword: "secret",
    });
    expect(cmd).toContain("sudo -S -u 'postgres' bash -c 'pg_dump db'");
    expect(cmd).toContain("'secret'");
  });

  it("THROWS when runAsUser is set without sudoPassword", () => {
    expect(() =>
      buildDbShellCommand("systemd", "pg", "pg_dump db", {
        runAsUser: "postgres",
      })
    ).toThrow(/sudoPassword is required/);
  });
});

describe("buildSqlcmdCommand", () => {
  // The inner pipeline is shq-wrapped again by buildDbShellCommand, so the
  // single quotes get re-escaped — assert on quote-free tokens that survive.
  it("pipes the query into a probed sqlcmd invocation", () => {
    const cmd = buildSqlcmdCommand("SELECT 1", "sa", "pw", "docker", "sql");
    expect(cmd).toContain("SELECT 1");
    // tool path probed before PATH fallback
    expect(cmd).toContain("/opt/mssql-tools18/bin/sqlcmd");
    expect(cmd).toContain("/opt/mssql-tools/bin/sqlcmd");
    expect(cmd).toContain("exec sqlcmd");
    // wrapped in the service exec environment
    expect(cmd.startsWith("docker exec 'sql' bash -c ")).toBe(true);
  });

  it("forwards the user and password to sqlcmd's -U/-P flags", () => {
    const cmd = buildSqlcmdCommand(
      "SELECT 1",
      "opsdeck",
      "p@ssword",
      "systemd",
      "sql"
    );
    expect(cmd).toContain("opsdeck");
    expect(cmd).toContain("p@ssword");
  });

  it("appends extraArgs to the sqlcmd argument list", () => {
    const base = buildSqlcmdCommand("SELECT 1", "sa", "pw", "docker", "sql");
    const withArgs = buildSqlcmdCommand(
      "SELECT 1",
      "sa",
      "pw",
      "docker",
      "sql",
      ["-h", "-1", "-W"]
    );
    expect(base).not.toContain("-W");
    expect(withArgs).toContain("-h");
    expect(withArgs).toContain("-W");
  });
});

describe("dbAdminUser", () => {
  it("falls back to each engine's conventional superuser", () => {
    expect(dbAdminUser("postgres", null)).toBe("postgres");
    expect(dbAdminUser("mssql", null)).toBe("sa");
    expect(dbAdminUser("mysql", null)).toBe("root");
  });

  it("prefers a configured account, ignoring blank input", () => {
    expect(dbAdminUser("mysql", "opsdeck")).toBe("opsdeck");
    // A whitespace-only value is what an untouched form field submits; it must
    // not become the login.
    expect(dbAdminUser("mysql", "   ")).toBe("root");
    expect(dbAdminUser("mysql", undefined)).toBe("root");
  });
});

describe("buildMysqlCommand", () => {
  it("probes for the MariaDB binary before the MySQL one", () => {
    const cmd = buildMysqlCommand("SELECT 1", "root", "pw", "docker", "my");
    expect(cmd).toContain("command -v mariadb ");
    expect(cmd).toContain("command -v mysql)");
    expect(cmd).toContain("SELECT 1");
    expect(cmd.startsWith("docker exec 'my' bash -c ")).toBe(true);
  });

  it("passes the password via MYSQL_PWD, never as a flag", () => {
    const cmd = buildMysqlCommand("SELECT 1", "root", "p@ss", "systemd", "my");
    expect(cmd).toContain("export MYSQL_PWD=");
    expect(cmd).toContain("p@ss");
    // `-p<password>` would put the secret in argv, where `ps` exposes it.
    expect(cmd).not.toContain("-pp@ss");
    expect(cmd).not.toContain("--password");
  });

  it("forces TCP so the unix_socket auth plugin can't shadow the login", () => {
    const cmd = buildMysqlCommand("SELECT 1", "opsdeck", "pw", "docker", "my");
    expect(cmd).toContain("-h 127.0.0.1");
    expect(cmd).toContain("opsdeck");
  });

  it("appends extraArgs to the client argument list", () => {
    const base = buildMysqlCommand("SELECT 1", "root", "pw", "docker", "my");
    const withArgs = buildMysqlCommand(
      "SELECT 1",
      "root",
      "pw",
      "docker",
      "my",
      ["-N", "-B"]
    );
    expect(base).not.toContain("-N");
    expect(withArgs).toContain("-N");
    expect(withArgs).toContain("-B");
  });
});

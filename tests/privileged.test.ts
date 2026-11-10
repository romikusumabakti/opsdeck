import { describe, expect, it } from "vitest";
import {
  privileged,
  privilegedViaStdin,
  privilegeMode,
} from "@/lib/privileged";

const root = { username: "root", auth: "key", password: null } as const;
const rootWithPassword = {
  username: "root",
  auth: "password",
  password: "s3cr3t",
} as const;
const keyUser = { username: "ops", auth: "key", password: null } as const;
// A password left on a key server is never fed to sudo: the key moved it.
const keyUserWithPassword = {
  username: "ops",
  auth: "key",
  password: "s3cr3t",
} as const;
const passwordUser = {
  username: "ops",
  auth: "password",
  password: "p@ss'word",
} as const;
const passwordUserNoPassword = {
  username: "ops",
  auth: "password",
  password: null,
} as const;

const JOURNAL =
  "journalctl -u 'app' -n 100 -f --no-pager --output=short-iso 2>&1";

describe("privilegeMode", () => {
  it("is root for the root user, whatever the auth", () => {
    expect(privilegeMode(root)).toBe("root");
    expect(privilegeMode(rootWithPassword)).toBe("root");
  });

  it("is sudo-password only for password auth with a stored password", () => {
    expect(privilegeMode(passwordUser)).toBe("sudo-password");
  });

  it("is sudo-nopasswd for key auth or a missing password", () => {
    expect(privilegeMode(keyUser)).toBe("sudo-nopasswd");
    expect(privilegeMode(keyUserWithPassword)).toBe("sudo-nopasswd");
    expect(privilegeMode(passwordUserNoPassword)).toBe("sudo-nopasswd");
    expect(privilegeMode({ ...passwordUser, password: "" })).toBe(
      "sudo-nopasswd"
    );
  });
});

describe("privileged", () => {
  describe("root", () => {
    it("runs a plain command as is", () => {
      expect(privileged("systemctl restart 'app'", root)).toBe(
        "systemctl restart 'app'"
      );
    });

    it("switches user with runuser for runAsUser", () => {
      expect(
        privileged("bash -c 'pg_dump db'", root, { runAsUser: "postgres" })
      ).toBe("runuser -u 'postgres' -- bash -c 'pg_dump db'");
    });

    it("runs the journal command as is", () => {
      expect(privileged(JOURNAL, root)).toBe(JOURNAL);
    });

    it("never carries a stored password", () => {
      expect(privileged("true", rootWithPassword)).not.toContain("s3cr3t");
      expect(
        privileged("true", rootWithPassword, { runAsUser: "postgres" })
      ).not.toContain("s3cr3t");
    });
  });

  describe("sudo-nopasswd", () => {
    it("runs a plain command under sudo -n", () => {
      expect(privileged("systemctl restart 'app'", keyUser)).toBe(
        "sudo -n systemctl restart 'app'"
      );
    });

    it("passes runAsUser to sudo -u", () => {
      expect(
        privileged("bash -c 'pg_dump db'", keyUser, { runAsUser: "postgres" })
      ).toBe("sudo -n -u 'postgres' bash -c 'pg_dump db'");
    });

    it("runs the journal command under sudo -n", () => {
      expect(privileged(JOURNAL, keyUser)).toBe(`sudo -n ${JOURNAL}`);
    });

    it("never carries a stored password", () => {
      expect(privileged("true", keyUserWithPassword)).toBe("sudo -n true");
      expect(
        privileged("true", keyUserWithPassword, { runAsUser: "postgres" })
      ).toBe("sudo -n -u 'postgres' true");
    });
  });

  describe("sudo-password", () => {
    it("feeds the quoted password to sudo -S on stdin", () => {
      expect(privileged("systemctl restart 'app'", passwordUser)).toBe(
        "printf '%s\\n' 'p@ss'\\''word' | sudo -S systemctl restart 'app'"
      );
    });

    it("passes runAsUser to sudo -S -u", () => {
      expect(
        privileged("bash -c 'pg_dump db'", passwordUser, {
          runAsUser: "postgres",
        })
      ).toBe(
        "printf '%s\\n' 'p@ss'\\''word' | sudo -S -u 'postgres' bash -c 'pg_dump db'"
      );
    });

    it("feeds the password to the journal command", () => {
      expect(privileged(JOURNAL, passwordUser)).toBe(
        `printf '%s\\n' 'p@ss'\\''word' | sudo -S ${JOURNAL}`
      );
    });
  });
});

describe("privilegedViaStdin", () => {
  it("runs as root without stdin", () => {
    expect(privilegedViaStdin("rm -rf -- '/d/x'", rootWithPassword)).toEqual({
      command: "rm -rf -- '/d/x'",
    });
  });

  it("uses sudo -n without stdin on key servers", () => {
    expect(privilegedViaStdin("rm -rf -- '/d/x'", keyUserWithPassword)).toEqual(
      { command: "sudo -n rm -rf -- '/d/x'" }
    );
  });

  it("sends the sudo password on stdin, never in the command", () => {
    const { command, stdin } = privilegedViaStdin(
      "rm -rf -- '/d/x'",
      passwordUser
    );
    expect(command).toBe("sudo -S -p '' rm -rf -- '/d/x'");
    expect(command).not.toContain("word");
    expect(stdin).toBe("p@ss'word\n");
  });
});

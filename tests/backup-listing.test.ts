import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupListCommand, parseBackupListing } from "@/lib/backup-listing";
import { canAnyProject } from "@/lib/permissions";
import { buildDbShellCommand } from "@/lib/services";

const SQL = "\\.sql(\\.gz)?";

describe("backupListCommand", () => {
  const run = (dir: string) =>
    // Through the real wrapper (bash -c <shq(inner)>), so a second layer of
    // quoting cannot mangle the \t escapes.
    execFileSync(
      "bash",
      ["-c", buildDbShellCommand("systemd", "svc", backupListCommand(dir))],
      { encoding: "utf8" }
    );

  it("quotes the directory and avoids find -printf", () => {
    const cmd = backupListCommand("/var/b ak/it's");
    expect(cmd).toContain("'/var/b ak/it'\\''s'");
    expect(cmd).not.toContain("-printf");
  });

  it("lists name, size and mtime through the shell, tabs intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "backups with space-"));
    try {
      writeFileSync(join(dir, "my db.sql"), "12345");
      writeFileSync(join(dir, "b.sql.gz"), "");
      mkdirSync(join(dir, "sub.sql"));
      const backups = parseBackupListing(run(dir), "\\.sql(\\.gz)?");
      expect(backups.map((b) => [b.name, b.size]).sort()).toEqual([
        ["b.sql.gz", 0],
        ["my db.sql", 5],
      ]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("lists nothing, successfully, for an empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "empty-backups-"));
    try {
      expect(run(dir)).toBe("");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("lists nothing, successfully, for a missing directory", () => {
    expect(run(join(tmpdir(), "definitely-missing-backup-dir"))).toBe("");
  });
});

describe("parseBackupListing", () => {
  it("returns name, byte size and ISO mtime, newest first", () => {
    const out = [
      "a.sql\t10\t1761912000.0000000000",
      "b.sql.gz\t2048\t1761998400.0",
    ].join("\n");
    expect(parseBackupListing(out, SQL)).toEqual([
      { name: "b.sql.gz", size: 2048, modifiedAt: "2025-11-01T12:00:00.000Z" },
      { name: "a.sql", size: 10, modifiedAt: "2025-10-31T12:00:00.000Z" },
    ]);
  });

  it("keeps names containing spaces", () => {
    expect(parseBackupListing("my db.sql\t5\t1761912000.0\n", SQL)).toEqual([
      { name: "my db.sql", size: 5, modifiedAt: "2025-10-31T12:00:00.000Z" },
    ]);
  });

  it("skips other extensions and malformed lines", () => {
    const out = [
      "notes.txt\t1\t1761912000.0",
      "x.sql.gz.partial\t1\t1761912000.0",
      "nosize.sql\t\t1761912000.0",
      "bad.sql\tabc\t1761912000.0",
      "neg.sql\t-1\t1761912000.0",
      "extra.sql\t1\t1761912000.0\tjunk",
      "short.sql",
      "",
      "ok.sql\t1\t1761912000.0",
    ].join("\n");
    expect(parseBackupListing(out, SQL).map((b) => b.name)).toEqual(["ok.sql"]);
  });

  it("honours the mssql pattern", () => {
    const out = "db.bak\t3\t1761912000.0\ndb.sql\t3\t1761912000.0\n";
    expect(parseBackupListing(out, "\\.bak").map((b) => b.name)).toEqual([
      "db.bak",
    ]);
  });
});

describe("canAnyProject", () => {
  it("is true when any alternative is allowed", () => {
    expect(
      canAnyProject("contributor", [
        { database: ["drop"] },
        { database: ["restore"] },
      ])
    ).toBe(true);
  });
  it("is false when none is, or with no role", () => {
    expect(
      canAnyProject("viewer", [
        { database: ["backup"] },
        { database: ["restore"] },
      ])
    ).toBe(false);
    expect(canAnyProject(null, [{ project: ["read"] }])).toBe(false);
  });
});

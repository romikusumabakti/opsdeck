import { describe, expect, it } from "vitest";
import { backupListCommand, parseBackupListing } from "@/lib/backup-listing";
import { canAnyProject } from "@/lib/permissions";

const SQL = "\\.sql(\\.gz)?";

describe("backupListCommand", () => {
  it("quotes the directory", () => {
    expect(backupListCommand("/var/b ak/it's")).toBe(
      `find '/var/b ak/it'\\''s' -maxdepth 1 -type f -printf '%f\\t%s\\t%T@\\n'`
    );
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

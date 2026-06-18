import { describe, expect, it } from "vitest";
import {
  backupFilenameSchema,
  databaseNameSchema,
  isoDurationSchema,
  projectIdSchema,
} from "@/lib/validation";

describe("backupFilenameSchema", () => {
  it.each(["db_2024.sql", "db.sql.gz", "x.bak"])("accepts %s", (name) => {
    expect(backupFilenameSchema.safeParse(name).success).toBe(true);
  });

  it.each(["../etc/passwd", "a/b.sql", "foo.txt"])("rejects %s", (name) => {
    expect(backupFilenameSchema.safeParse(name).success).toBe(false);
  });
});

describe("databaseNameSchema", () => {
  it.each([
    "mydb",
    "my_db",
    "db1",
    "_internal",
    "app-prod",
    " a_b ",
  ])("accepts %s", (name) => {
    expect(databaseNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    "",
    "-leading-hyphen",
    "has space",
    "a/b",
    "../etc",
    "drop;table",
    'quote"d',
    "back`tick",
  ])("rejects %s", (name) => {
    expect(databaseNameSchema.safeParse(name).success).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    const parsed = databaseNameSchema.safeParse("  mydb  ");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe("mydb");
  });
});

describe("isoDurationSchema", () => {
  it.each(["PT1H", "-P1D"])("accepts %s", (dur) => {
    expect(isoDurationSchema.safeParse(dur).success).toBe(true);
  });

  it.each(["P", "garbage"])("rejects %s", (dur) => {
    expect(isoDurationSchema.safeParse(dur).success).toBe(false);
  });
});

describe("projectIdSchema", () => {
  it("accepts a valid uuid", () => {
    expect(
      projectIdSchema.safeParse("018f3e3a-7b2c-7c3d-8e4f-1a2b3c4d5e6f").success
    ).toBe(true);
  });

  it("rejects a non-uuid", () => {
    expect(projectIdSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

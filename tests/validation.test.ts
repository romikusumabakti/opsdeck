import { describe, expect, it } from "bun:test";
import {
  backupFilenameSchema,
  databaseNameSchema,
  explorerRelativePathSchema,
  isoDurationSchema,
  projectKeySchema,
  subdomainLabelSchema,
  tunnelRouteInputSchema,
  uuidSchema,
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
  it.each(["mydb", "my_db", "db1", "_internal", "app-prod", " a_b "])(
    "accepts %s",
    (name) => {
      expect(databaseNameSchema.safeParse(name).success).toBe(true);
    }
  );

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

describe("uuidSchema", () => {
  it("accepts a valid uuid", () => {
    expect(
      uuidSchema.safeParse("018f3e3a-7b2c-7c3d-8e4f-1a2b3c4d5e6f").success
    ).toBe(true);
  });

  it("rejects a non-uuid", () => {
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("projectKeySchema", () => {
  it.each(["CMEM", "tmem", "P2SK9"])("accepts %s", (key) => {
    expect(projectKeySchema.safeParse(key).success).toBe(true);
  });

  it("uppercases the key", () => {
    expect(projectKeySchema.parse("cmem")).toBe("CMEM");
  });

  it.each(["A", "TOOLONGKEY1", "1ABC"])("rejects malformed %s", (key) => {
    expect(projectKeySchema.safeParse(key).success).toBe(false);
  });

  // A project key is also a top-level URL segment (/[projectKey]/[envSlug]),
  // so one that matches a real route would be unreachable.
  it.each(["projects", "ISSUES", "servers", "api"])(
    "rejects route-colliding %s",
    (key) => {
      expect(projectKeySchema.safeParse(key).success).toBe(false);
    }
  );
});

describe("explorerRelativePathSchema", () => {
  it("normalizes a folder-upload path", () => {
    expect(explorerRelativePathSchema.parse("dist/assets/app.js")).toBe(
      "dist/assets/app.js"
    );
    // Windows separators and redundant slashes collapse.
    expect(explorerRelativePathSchema.parse("dist\\assets//app.js")).toBe(
      "dist/assets/app.js"
    );
  });

  it.each(["../etc/passwd", "a/../b", "a/./b", "", "/", "a/\u0000/b"])(
    "rejects %j",
    (input) => {
      expect(explorerRelativePathSchema.safeParse(input).success).toBe(false);
    }
  );

  it("rejects a path deeper than the segment limit", () => {
    const deep = Array.from({ length: 65 }, (_, i) => `d${i}`).join("/");
    expect(explorerRelativePathSchema.safeParse(deep).success).toBe(false);
  });
});

describe("subdomainLabelSchema", () => {
  it.each(["dapenmu-portal", "app", "a1", "x".repeat(63)])(
    "accepts %s",
    (label) => {
      expect(subdomainLabelSchema.safeParse(label).success).toBe(true);
    }
  );

  // The rule that shapes every hostname on these tunnels: Cloudflare's free
  // Universal SSL covers `*.zone` and nothing deeper, so a multi-level name
  // would be served a certificate that does not match it.
  it("rejects a multi-level name", () => {
    const result = subdomainLabelSchema.safeParse("portal.dapenmu");
    expect(result.success).toBe(false);
  });

  it.each(["-lead", "trail-", "under_score", "dots.here", "", "x".repeat(64)])(
    "rejects %s",
    (label) => {
      expect(subdomainLabelSchema.safeParse(label).success).toBe(false);
    }
  );

  it("lowercases what it accepts, so the hostname is canonical", () => {
    // `.trim().toLowerCase()` run before the regex, so mixed case is coerced
    // rather than refused — only characters outside the class are rejected.
    expect(subdomainLabelSchema.parse("  Portal  ")).toBe("portal");
  });
});

describe("tunnelRouteInputSchema", () => {
  const base = {
    tunnelId: "0198f0a0-0000-7000-8000-000000000000",
    label: "dapenmu-foo",
    originHost: "dplk-middleware",
    originPort: 3000,
  };

  it("accepts a container origin and its internal port", () => {
    expect(tunnelRouteInputSchema.safeParse(base).success).toBe(true);
  });

  it("coerces a port arriving as a string from the form", () => {
    const result = tunnelRouteInputSchema.safeParse({
      ...base,
      originPort: "8080",
    });
    expect(result.success && result.data.originPort).toBe(8080);
  });

  it.each([0, 65536, 1.5])("rejects port %s", (originPort) => {
    expect(
      tunnelRouteInputSchema.safeParse({ ...base, originPort }).success
    ).toBe(false);
  });

  it("rejects an origin host carrying a path or shell metacharacter", () => {
    for (const originHost of ["a/b", "a;rm -rf /", "$(id)", "-leading"]) {
      expect(
        tunnelRouteInputSchema.safeParse({ ...base, originHost }).success
      ).toBe(false);
    }
  });
});

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixtures intentionally contain ${...} placeholders
import { describe, expect, it } from "vitest";
import {
  containsSecret,
  fileVerdict,
  isWithheldPath,
} from "@/lib/assistant/secret-filter";

describe("isWithheldPath", () => {
  it.each([
    "backend/.env",
    ".env",
    "a/b/.ENV",
    ".env.production",
    ".env.local",
    "deploy/keys/server.pem",
    "deploy/KEY.PEM",
    "src/main/resources/keystore.jks",
    "x/app.key",
    "x/a.p12",
    "x/a.pfx",
    "x/a.keystore",
    "home/.ssh/id_rsa",
    "home/.ssh/id_rsa.pub",
    "home/.ssh/id_ed25519",
    "vault/db.kdbx",
    "config/credentials.json",
    "config/Credentials",
    "config/secrets.yml",
    "infra/secrets/anything.txt",
    "infra/Secrets/deep/er/file.md",
    "backup/db.sql.gz",
    "backup/db.dump",
    "backup/db.bak",
    ".git/config",
    "sub/.git/HEAD",
    "node_modules/x/index.js",
    "web/node_modules/x/index.js",
    "a\\b\\.env",
    "./backend/.env",
  ])("withholds %s", (p) => {
    expect(isWithheldPath(p)).toBe(true);
  });

  it.each([
    "src/main/java/Iuran.java",
    "docs/MEMBERSHIP_API_KSTP.md",
    ".env.example",
    ".env.sample",
    "a/.env.template",
    "config/application-prod.yml",
    "config/application-test.properties",
    "config/application.yaml",
    "src/environment.ts",
    "src/keyboard.ts",
    "src/monkey.ts",
    "db/seed/data.sql",
    ".github/workflows/ci.yml",
    "docs/gitignore.md",
    "src/secret-filter.ts.md",
  ])("does not withhold by path %s", (p) => {
    expect(isWithheldPath(p)).toBe(false);
  });
});

describe("containsSecret", () => {
  it.each([
    "spring.datasource.password=Sup3rS3cret!",
    "password: hunter2secret",
    'PASSWORD = "hunter2secret"',
    "api_key: abcdef123456",
    "API-KEY=abcdef123456",
    "client_secret: 'abcdef123456'",
    "token=abcdef123456",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE",
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "aws=AKIAABCDEFGHIJKLMNOP",
    "ATATT3xFfGF0abcdefghijklmnopqrstuvwx=",
    "sk-ant-api03-abcdefghijklmnopqrst",
  ])("detects %s", (t) => {
    expect(containsSecret(t)).toBe(true);
  });

  it.each([
    "password: ${DB_PASSWORD}",
    'password: "${DB_PASSWORD}"',
    "spring.datasource.password=${DB_PASSWORD}",
    "DB_PASSWORD=${DB_PASSWORD}",
    "password=",
    "password: abc",
    "const x = 1;",
    "-----BEGIN PUBLIC KEY-----",
    "-----BEGIN CERTIFICATE-----",
    "AKIA123",
    "sk-ant-short",
    "",
  ])("ignores %j", (t) => {
    expect(containsSecret(t)).toBe(false);
  });

  it("scans large inputs quickly (no catastrophic backtracking)", () => {
    const big = `password${" ".repeat(200000)}x\n${"a".repeat(2_000_000)}`;
    const t = Date.now();
    containsSecret(big);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("fileVerdict", () => {
  it("allows clean source", () => {
    expect(fileVerdict("src/main/java/Iuran.java", "class Iuran {}")).toBe(
      "allowed"
    );
  });

  it("allows .env.example with placeholders", () => {
    expect(fileVerdict(".env.example", "DB_PASSWORD=${DB_PASSWORD}")).toBe(
      "allowed"
    );
  });

  it("withholds .env.example holding a real secret", () => {
    expect(fileVerdict(".env.example", "DB_PASSWORD=hunter2secret")).toBe(
      "withheld"
    );
  });

  it("withholds .env regardless of content", () => {
    expect(fileVerdict("backend/.env", "A=1")).toBe("withheld");
  });

  it("decides application-<profile> files by content", () => {
    for (const p of ["prod", "test", "local", "kestrel"]) {
      const path = `config/application-${p}.yml`;
      expect(fileVerdict(path, "spring.datasource.password=Sup3rS3cret!")).toBe(
        "withheld"
      );
      expect(
        fileVerdict(path, "spring.datasource.password=${DB_PASSWORD}")
      ).toBe("allowed");
    }
    expect(
      fileVerdict("a/application-prod.properties", "password=Sup3rS3cret!")
    ).toBe("withheld");
  });

  it("withholds binary content (NUL in first 8 KiB)", () => {
    expect(fileVerdict("a/logo.png", `PNG\0data`)).toBe("withheld");
    expect(fileVerdict("a/ok.txt", `${"a".repeat(9000)}\0`)).toBe("allowed");
  });

  const MiB = 1024 * 1024;
  it.each([
    ["db/seed/data.sql", true],
    ["db/Seeds/nested/data.sql", true],
    ["db/seed-data.sql", true],
    ["db/migration/V1__seed_users.sql", true],
    ["db/seed/readme.md", false],
    ["db/migration/V1__init.sql", false],
  ])("seed heuristic %s over 1 MiB -> withheld=%s", (p, w) => {
    expect(fileVerdict(p, "INSERT INTO t VALUES (1);", MiB + 1)).toBe(
      w ? "withheld" : "allowed"
    );
  });

  it("allows seed SQL up to 1 MiB and defaults size to content length", () => {
    expect(fileVerdict("db/seed/data.sql", "x", MiB)).toBe("allowed");
    expect(fileVerdict("db/seed/data.sql", "x".repeat(MiB + 1))).toBe(
      "withheld"
    );
  });
});

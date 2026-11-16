// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixtures intentionally contain ${...} placeholders
import { describe, expect, it } from "vitest";
import {
  containsSecret,
  fileKind,
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
    ".envrc",
    "app/.envrc",
    "config/credentials.yml",
    "docs/secrets.md",
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
    "src/main/java/CredentialsService.java",
    "src/services/secrets.service.ts",
    "app/credentials.py",
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
    "password: ab",
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
    expect(fileVerdict("a/ok.txt", `${"a".repeat(8191)}\0`)).toBe("withheld");
    expect(fileVerdict("a/ok.txt", `${"a".repeat(8192)}\0`)).toBe("allowed");
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

describe("fileKind", () => {
  it.each([
    ["a/UserService.java", "code"],
    ["a/b.vue", "code"],
    ["a/b.MJS", "code"],
    ["a/application.yml", "config"],
    ["a/.env.example", "config"],
    ["a/.env", "config"],
    ["a/.npmrc", "config"],
    ["a/pom.xml", "config"],
    ["a/package.json", "config"],
    ["a/README.md", "other"],
    ["a/Dockerfile", "other"],
  ])("%s -> %s", (p, k) => {
    expect(fileKind(p)).toBe(k);
  });
});

describe("containsSecret in code", () => {
  it.each([
    'const JWT_SECRET = "abc123xyz"',
    'password = "Sup3rS3cret!"',
    'String dbPassword = "hunter2secret";',
    "apiKey: 'abcdef123456',",
    'password := "hunter2secret"',
    "const o = { token: 'abcdef123456' }",
    'client_secret="abcdef123456"',
  ])("detects %s", (t) => {
    expect(containsSecret(t, "code")).toBe(true);
  });

  it.each([
    "this.token = token;",
    "String password = request.getPassword();",
    "password: string;",
    "clientSecret: z.string(),",
    "apiKey: process.env.API_KEY,",
    "token: AuthService.getToken()",
    'const password = "${DB_PASSWORD}"',
    'const password = "$DB_PASSWORD"',
    'const password = "{{ password }}"',
    'const password = "<your-password>"',
    'token = "abc"',
    'if (password == "abcdefgh") {}',
    'const t = "tokenizer"',
    "password =\n  'abcdefgh'",
  ])("ignores %j", (t) => {
    expect(containsSecret(t, "code")).toBe(false);
  });

  it("still catches shape-based tokens and URL credentials in code", () => {
    expect(containsSecret("x = AKIAABCDEFGHIJKLMNOP", "code")).toBe(true);
    expect(containsSecret('u = "https://bob:pa55@host/x"', "code")).toBe(true);
  });
});

describe("containsSecret in config", () => {
  it.each([
    "POSTGRES_PASSWORD: root",
    "MYSQL_ROOT_PASSWORD=root",
    "password: admin",
    "secret-key: abcdef",
    "secretKey: abcdef",
    "access-key-id: abc",
    "private-key: abc",
    "//registry.npmjs.org/:_authToken=abc123",
    "_auth=dXNlcjpwYXNz",
    '{"password": "x12"}',
    '"password": "root"',
    "<password>root</password>",
    "<settings><token>abc123</token></settings>",
    "password=${DB_PASSWORD:changeme}",
    "password: ${DB_PASSWORD:-changeme}",
    "password={noop}secret",
    "password: {bcrypt}$2a$10$abc",
    "url=postgres://app:s3cret@db:5432/x",
    `ghp_${"a".repeat(36)}`,
    `github_pat_${"A".repeat(22)}`,
    "xoxb-1234567890-abcdef",
    `AIza${"a".repeat(35)}`,
  ])("detects %s", (t) => {
    expect(containsSecret(t, "config")).toBe(true);
  });

  it.each([
    "password: ${DB_PASSWORD}",
    "password: $DB_PASSWORD",
    "password: {{ .Values.password }}",
    "password: <your-password>",
    "password: ENC(abcdef123)",
    "password=${DB_PASSWORD:}",
    "password: ab",
    "password:\n  something",
    "<password>x</password>",
    "token: null",
    "url=postgres://app:${DB_PASS}@db:5432/x",
    "url=https://example.com/a:b@c",
    "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
    "tokenizer: whitespace",
    "passwordEncoder: bcrypt",
  ])("ignores %j", (t) => {
    expect(containsSecret(t, "config")).toBe(false);
  });
});

describe("fileVerdict by kind", () => {
  it("applies code rules to code files and config rules to config files", () => {
    const line = "token: AuthService.getToken()";
    expect(fileVerdict("src/App.vue", line)).toBe("allowed");
    expect(fileVerdict("src/app.yml", "password: admin")).toBe("withheld");
    expect(fileVerdict("src/Auth.java", "password: admin")).toBe("allowed");
    expect(fileVerdict("notes.txt", "password: admin")).toBe("withheld");
    expect(fileVerdict("docker-compose.yml", "POSTGRES_PASSWORD: root")).toBe(
      "withheld"
    );
  });
});

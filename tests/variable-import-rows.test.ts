/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: .env text */
import { describe, expect, it } from "vitest";
import { parseDotenv } from "@/lib/variables/dotenv";
import {
  type ImportExisting,
  type ImportFile,
  type ImportTemplate,
  looksSecret,
  planImportRows,
  selectImportWrites,
} from "@/lib/variables/import-rows";
import { VARIABLE_VALUE_MAX_LENGTH } from "@/lib/variables/validation";

// The pure half of "Import .env": which rows a parsed file proposes, with
// which kind, state and flags, and which values a save may write. Fixtures
// are fictional.

const SECRET = "FAKE_IMPORT_SECRET_91c2";

function parsed(text: string) {
  const result = parseDotenv(text);
  if ("error" in result) throw new Error("fixture does not parse");
  return result.entries;
}

function textFile(text: string): ImportFile {
  return { entries: parsed(text) };
}

function dirFile(deployDir: string, text: string, fingerprint = deployDir) {
  return {
    dir: { serverName: "kestrel-app", deployDir, fingerprint },
    entries: parsed(text),
  };
}

function plan(
  files: ImportFile[],
  {
    existing = {},
    templates = {},
    tagNames = ["IMAGE_TAG"],
  }: {
    existing?: Record<string, ImportExisting>;
    templates?: Record<string, ImportTemplate>;
    tagNames?: string[];
  } = {}
) {
  return planImportRows({
    files,
    existing: new Map(Object.entries(existing)),
    templates: new Map(Object.entries(templates)),
    tagNames,
  });
}

function rowOf(result: ReturnType<typeof plan>, name: string) {
  const found = result.rows.find((p) => p.row.name === name);
  if (!found) throw new Error(`no row ${name}`);
  return found.row;
}

describe("looksSecret", () => {
  it("flags secret words anywhere in the name", () => {
    for (const name of [
      "DB_PASSWORD",
      "SMTP_PASSWD",
      "GPG_PASSPHRASE",
      "CLIENT_SECRET",
      "GITLAB_TOKEN",
      "AWS_CREDENTIALS",
      "PRIVATE_KEY_PEM",
      "MAPSAPIKEY",
      "S3_ACCESS_KEY_ID",
      "JWT_SIGNING_ALG",
    ]) {
      expect(looksSecret(name, "x"), name).toBe(true);
    }
  });

  it("flags short words only as whole _-separated segments", () => {
    for (const name of [
      "KEY",
      "API_KEY",
      "MAIL_PASS",
      "DB_PWD",
      "HASH_SALT",
      "SENTRY_DSN",
      "TLS_CERT",
    ]) {
      expect(looksSecret(name, "x"), name).toBe(true);
    }
    for (const name of [
      "MONKEY",
      "KEYCLOAK_URL",
      "PASSPORT_URL",
      "COMPOSE_PROFILES",
    ]) {
      expect(looksSecret(name, "x"), name).toBe(false);
    }
  });

  it("flags URL credentials in the value", () => {
    expect(
      looksSecret("DATABASE_URL", "postgres://app:hunter2@db:5432/x")
    ).toBe(true);
    expect(looksSecret("REDIS_URL", "redis://:hunter2@cache:6379")).toBe(true);
    expect(looksSecret("APP_URL", "https://app.example.test/a@b")).toBe(false);
    expect(looksSecret("APP_URL", "https://app.example.test:8443/")).toBe(
      false
    );
  });
});

describe("planImportRows", () => {
  it("skips tag variables, DOCKER_REGISTRY and reserved names, keeping COMPOSE_PROFILES", () => {
    const result = plan([
      textFile(
        "IMAGE_TAG=1.2.3\nDOCKER_REGISTRY=registry.example.test\nCOMPOSE_FILE=a.yaml\nCOMPOSE_PROJECT_NAME=x\nBUILDKIT_PROGRESS=plain\nCOMPOSE_PROFILES=worker\nAPP_NAME=kestrel\n"
      ),
    ]);
    expect(result.skipped).toEqual([
      { name: "BUILDKIT_PROGRESS", reason: "reserved" },
      { name: "COMPOSE_FILE", reason: "reserved" },
      { name: "COMPOSE_PROJECT_NAME", reason: "reserved" },
      { name: "DOCKER_REGISTRY", reason: "dockerRegistry" },
      { name: "IMAGE_TAG", reason: "tagVariable" },
    ]);
    expect(result.rows.map((p) => p.row.name)).toEqual([
      "APP_NAME",
      "COMPOSE_PROFILES",
    ]);
    expect(rowOf(result, "COMPOSE_PROFILES")).toMatchObject({
      proposedKind: "plain",
      value: "worker",
      state: "new",
    });
  });

  it("proposes the Panel kind, then the template kind, then the heuristic", () => {
    const result = plan(
      [
        textFile(
          `FEATURE_TOKEN_NAME=x\nJWT_SECRET=${SECRET}\nVAULT_KEY=${SECRET}\nSESSION_SECRET=${SECRET}\nLOG_LEVEL=info\n`
        ),
      ],
      {
        existing: {
          FEATURE_TOKEN_NAME: { kind: "plain", value: "old", escrow: false },
        },
        templates: {
          JWT_SECRET: { kind: "generated", escrow: false },
          VAULT_KEY: { kind: "generated", escrow: true },
        },
      }
    );
    expect(rowOf(result, "FEATURE_TOKEN_NAME").proposedKind).toBe("plain");
    expect(rowOf(result, "JWT_SECRET").proposedKind).toBe("generated");
    expect(rowOf(result, "VAULT_KEY").proposedKind).toBe("generated");
    expect(rowOf(result, "SESSION_SECRET").proposedKind).toBe("secret");
    expect(rowOf(result, "LOG_LEVEL").proposedKind).toBe("plain");
    const vault = result.rows.find((p) => p.row.name === "VAULT_KEY");
    expect(vault?.escrow).toBe(true);
    const jwt = result.rows.find((p) => p.row.name === "JWT_SECRET");
    expect(jwt?.escrow).toBe(false);
  });

  it("returns a value only for rows proposed plain", () => {
    const result = plan([textFile(`LOG_LEVEL=info\nDB_PASSWORD=${SECRET}\n`)]);
    expect(rowOf(result, "LOG_LEVEL").value).toBe("info");
    expect(rowOf(result, "DB_PASSWORD").value).toBeNull();
    expect(JSON.stringify(result.rows.map((p) => p.row))).not.toContain(SECRET);
  });

  it("compares with the stored value: new, same, conflict", () => {
    const result = plan([textFile(`A=1\nB=2\nDB_PASSWORD=${SECRET}\nC=3\n`)], {
      existing: {
        A: { kind: "plain", value: "1", escrow: false },
        B: { kind: "plain", value: "9", escrow: false },
        DB_PASSWORD: { kind: "secret", value: "stored-other", escrow: false },
      },
    });
    expect(rowOf(result, "A").state).toBe("same");
    expect(rowOf(result, "B").state).toBe("conflict");
    expect(rowOf(result, "DB_PASSWORD")).toMatchObject({
      state: "conflict",
      value: null,
    });
    expect(rowOf(result, "C").state).toBe("new");
    const json = JSON.stringify(result.rows.map((p) => p.row));
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("stored-other");
  });

  it("marks unimportable rows with a reason and no value", () => {
    const long = "v".repeat(VARIABLE_VALUE_MAX_LENGTH + 1);
    const result = plan(
      [
        textFile(
          `lower_case=1\nMULTI="a\nb"\nLONG=${long}\nLOCKED=new\nLOCKED_SAME=kept\n`
        ),
      ],
      {
        existing: {
          LOCKED: { kind: "generated", value: "old", escrow: true },
          LOCKED_SAME: { kind: "plain", value: "kept", escrow: true },
        },
      }
    );
    expect(rowOf(result, "lower_case")).toMatchObject({
      state: "unimportable",
      reason: "invalidName",
      value: null,
    });
    expect(rowOf(result, "MULTI")).toMatchObject({
      state: "unimportable",
      reason: "multiLine",
      value: null,
    });
    expect(rowOf(result, "LONG")).toMatchObject({
      state: "unimportable",
      reason: "tooLong",
      value: null,
    });
    expect(rowOf(result, "LOCKED")).toMatchObject({
      state: "unimportable",
      reason: "escrowed",
    });
    // Equal to the escrowed value: nothing to write, so just "same".
    expect(rowOf(result, "LOCKED_SAME").state).toBe("same");
  });

  it("flags unresolved references and duplicates", () => {
    const result = plan([
      textFile("A=${MISSING_HOST}:${OTHER}\nB=1\nB=2\nC=${B}\n"),
    ]);
    expect(rowOf(result, "A").flags).toEqual({
      unresolvedRefs: ["MISSING_HOST", "OTHER"],
    });
    expect(rowOf(result, "B").flags).toEqual({ duplicate: true });
    expect(rowOf(result, "C")).toMatchObject({ value: "2", flags: {} });
  });

  it("has no sources for text", () => {
    const result = plan([textFile("A=1\n")]);
    expect(rowOf(result, "A").sources).toBeUndefined();
  });

  it("lists each dir as a source and flags values that differ across dirs", () => {
    const result = plan([
      dirFile(
        "/srv/kestrel/api",
        `SAME=1\nLOG_LEVEL=info\nDB_PASSWORD=${SECRET}-a\nONLY_API=x\n`,
        "fpA"
      ),
      dirFile(
        "/srv/kestrel/web",
        `SAME=1\nLOG_LEVEL=debug\nDB_PASSWORD=${SECRET}-b\n`,
        "fpB"
      ),
    ]);
    const same = rowOf(result, "SAME");
    expect(same.flags).toEqual({});
    expect(same.value).toBe("1");
    expect(same.sources?.map((s) => s.deployDir)).toEqual([
      "/srv/kestrel/api",
      "/srv/kestrel/web",
    ]);

    const level = rowOf(result, "LOG_LEVEL");
    expect(level.flags).toEqual({ differsAcrossDirs: true });
    // Plain: each dir's value, none at the top (no dir is the default).
    expect(level.value).toBeNull();
    expect(level.sources).toEqual([
      {
        serverName: "kestrel-app",
        deployDir: "/srv/kestrel/api",
        valueId: "0:fpA:2",
        value: "info",
      },
      {
        serverName: "kestrel-app",
        deployDir: "/srv/kestrel/web",
        valueId: "1:fpB:2",
        value: "debug",
      },
    ]);

    const password = rowOf(result, "DB_PASSWORD");
    expect(password.flags).toEqual({ differsAcrossDirs: true });
    expect(password.sources?.every((s) => s.value === undefined)).toBe(true);
    expect(JSON.stringify(result.rows.map((p) => p.row))).not.toContain(SECRET);

    expect(rowOf(result, "ONLY_API").flags).toEqual({});
  });

  it("keeps valueIds unique across byte-identical dirs", () => {
    const same = "LOG_LEVEL=info\n";
    const result = plan([
      dirFile("/srv/a", same, "fpSame"),
      dirFile("/srv/b", same, "fpSame"),
      dirFile("/srv/c", "LOG_LEVEL=debug\n", "fpOther"),
    ]);
    const ids = rowOf(result, "LOG_LEVEL").sources?.map((s) => s.valueId);
    expect(ids).toEqual(["0:fpSame:1", "1:fpSame:1", "2:fpOther:1"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("calls a row with differing dirs a conflict when one dir matches the Panel", () => {
    const result = plan(
      [
        dirFile("/srv/a", "LOG_LEVEL=info\n"),
        dirFile("/srv/b", "LOG_LEVEL=debug\n"),
      ],
      {
        existing: {
          LOG_LEVEL: { kind: "plain", value: "info", escrow: false },
        },
      }
    );
    expect(rowOf(result, "LOG_LEVEL").state).toBe("conflict");
  });
});

describe("selectImportWrites", () => {
  const files = [
    dirFile(
      "/srv/a",
      `LOG_LEVEL=info\nAPP_NAME=kestrel\nDB_PASSWORD=${SECRET}\n`,
      "fpA"
    ),
    dirFile("/srv/b", "LOG_LEVEL=debug\nAPP_NAME=kestrel\n", "fpB"),
  ];

  it("writes the chosen dir's value and the requested kind", () => {
    const { rows } = plan(files);
    const result = selectImportWrites(rows, [
      { name: "LOG_LEVEL", kind: "plain", valueId: "1:fpB:1" },
      { name: "APP_NAME", kind: "secret" },
      { name: "DB_PASSWORD", kind: "plain" },
    ]);
    expect(result).toEqual({
      writes: [
        {
          name: "LOG_LEVEL",
          kind: "plain",
          value: "debug",
          escrow: false,
          overwrites: false,
        },
        {
          name: "APP_NAME",
          kind: "secret",
          value: "kestrel",
          escrow: false,
          overwrites: false,
        },
        {
          name: "DB_PASSWORD",
          kind: "plain",
          value: SECRET,
          escrow: false,
          overwrites: false,
        },
      ],
    });
  });

  it("refuses a differing row without a dir, and an unknown valueId", () => {
    const { rows } = plan(files);
    expect(
      selectImportWrites(rows, [{ name: "LOG_LEVEL", kind: "plain" }])
    ).toEqual({ issue: { code: "importSourceRequired", name: "LOG_LEVEL" } });
    expect(
      selectImportWrites(rows, [
        { name: "LOG_LEVEL", kind: "plain", valueId: "1:fpX:1" },
      ])
    ).toEqual({ issue: { code: "importSourceUnknown", name: "LOG_LEVEL" } });
  });

  it("refuses unknown, duplicate, same and unimportable rows", () => {
    const { rows } = plan([textFile("A=1\nB=2\nlower=3\n")], {
      existing: { A: { kind: "plain", value: "1", escrow: false } },
    });
    expect(selectImportWrites(rows, [{ name: "NOPE", kind: "plain" }])).toEqual(
      { issue: { code: "importRowUnknown", name: "NOPE" } }
    );
    expect(
      selectImportWrites(rows, [
        { name: "B", kind: "plain" },
        { name: "B", kind: "secret" },
      ])
    ).toEqual({ issue: { code: "importRowDuplicate", name: "B" } });
    expect(selectImportWrites(rows, [{ name: "A", kind: "plain" }])).toEqual({
      issue: { code: "importRowSame", name: "A" },
    });
    expect(
      selectImportWrites(rows, [{ name: "lower", kind: "plain" }])
    ).toEqual({
      issue: {
        code: "importRowUnimportable",
        name: "lower",
        reason: "invalidName",
      },
    });
  });

  it("keeps an existing variable's escrow flag and marks it overwritten", () => {
    const { rows } = plan([textFile("B=2\n")], {
      existing: { B: { kind: "secret", value: "1", escrow: false } },
      templates: { B: { kind: "secret", escrow: true } },
    });
    expect(selectImportWrites(rows, [{ name: "B", kind: "secret" }])).toEqual({
      writes: [
        {
          name: "B",
          kind: "secret",
          value: "2",
          escrow: false,
          overwrites: true,
        },
      ],
    });
  });
});

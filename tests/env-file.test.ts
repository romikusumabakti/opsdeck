import { describe, expect, it } from "vitest";
import { ENV_FILE_HEADER, renderEnvFile } from "@/lib/variables/env-file";

// Review Focus 1: every value must reach the container exactly as stored.
// The rendered file is read back with a reference parser written here from
// compose-go v2.16.2's dotenv parser (dotenv/parser.go, dotenv/godotenv.go,
// template/template.go), independently of the renderer. Any interpolation it
// performs yields INTERPOLATED, so a `$` that leaks through fails loudly.

const REGISTRY = "192.168.10.113:5000";

const INTERPOLATED = "<INTERPOLATED>";

function isSpace(c: string): boolean {
  // parser.go isSpace: space characters but not line breaks.
  return /^[\t\v\f\r \u0085\u00a0]$/.test(c);
}

// template.go: `$$` -> `$`; `$name` / `${...}` -> substitution; any other `$`
// is left alone.
function substitute(value: string): string {
  return value.replace(
    /\$(?:(\$)|([_a-z][_a-z0-9]*)|\{[^}]*\}?)/gi,
    (_m, escaped: string | undefined) =>
      escaped === undefined ? INTERPOLATED : "$"
  );
}

// parser.go expandEscapes: only \a \b \c(kept) \f \n \r \t \v \$ \" \\ and
// \0 octal are expanded; `\$` becomes `$$` for the substitution step.
function expandEscapes(value: string): string {
  const simple: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    '"': '"',
    "\\": "\\",
  };
  return value.replace(
    /\\(?:([abcfnrtv$"\\])|0(\d{0,3}))/g,
    (match, ch: string | undefined, octal: string | undefined) => {
      if (ch === "$") return "$$";
      if (ch !== undefined) return simple[ch] ?? match; // `\c` is not a Go escape
      // `\0ddd` -> Go `\ddd`: exactly three octal digits, at most 0o377.
      const code = /^[0-7]{3}$/.test(octal ?? "")
        ? Number.parseInt(octal as string, 8)
        : 256;
      return code <= 0o377 ? String.fromCharCode(code) : match;
    }
  );
}

function parseDotenv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  let rest = src;
  for (;;) {
    // getStatementStart: skip whitespace and `#` comment lines.
    const start = rest.search(/\S/);
    if (start === -1) break;
    rest = rest.slice(start);
    if (rest[0] === "#") {
      const nl = rest.indexOf("\n");
      if (nl === -1) break;
      rest = rest.slice(nl);
      continue;
    }
    // locateKeyName (the renderer never writes `export` or `:` forms).
    const eq = rest.search(/[=\n]/);
    if (eq === -1 || rest[eq] !== "=") throw new Error("no '=' in statement");
    const key = rest.slice(0, eq).trimEnd();
    if (!/^[A-Za-z0-9_.\-[\]]+$/.test(key)) throw new Error(`bad key ${key}`);
    rest = rest.slice(eq + 1);
    while (rest !== "" && isSpace(rest[0] as string)) rest = rest.slice(1);

    const quote = rest[0];
    if (quote !== "'" && quote !== '"') {
      const nl = rest.indexOf("\n");
      let value = nl === -1 ? rest : rest.slice(0, nl);
      rest = nl === -1 ? "" : rest.slice(nl + 1);
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment);
      out[key] = substitute(value.trimEnd());
      continue;
    }

    // extractVarValue, quoted: a backslash escapes the closing quote (and is
    // dropped); before any other character it is kept along with it.
    let chars = "";
    let escaped = false;
    let closed = -1;
    for (let i = 1; i < rest.length; i++) {
      const c = rest[i] as string;
      if (c !== quote) {
        if (!escaped && c === "\\") {
          escaped = true;
          continue;
        }
        if (escaped) {
          escaped = false;
          chars += "\\";
        }
        chars += c;
        continue;
      }
      if (escaped) {
        escaped = false;
        chars += c;
        continue;
      }
      closed = i;
      break;
    }
    if (closed === -1) throw new Error(`unterminated quoted value for ${key}`);
    out[key] = quote === '"' ? substitute(expandEscapes(chars)) : chars;
    rest = rest.slice(closed + 1);
  }
  return out;
}

describe("reference parser (compose-go v2.16.2 rules)", () => {
  it("keeps single-quoted text literal and interpolates double-quoted", () => {
    expect(parseDotenv("A='$HOME #x'\n")).toEqual({ A: "$HOME #x" });
    expect(parseDotenv('A="$HOME"\n')).toEqual({ A: INTERPOLATED });
    expect(parseDotenv('A="$$HOME \\$x \\\\ \\""\n')).toEqual({
      A: '$HOME $x \\ "',
    });
    expect(parseDotenv("A=x #c\nB=y#z\n")).toEqual({ A: "x", B: "y#z" });
  });

  it("cannot close a single-quoted value that ends with a backslash", () => {
    // Why the renderer double-quotes any value containing `\`.
    expect(() => parseDotenv("A='abc\\'\n")).toThrow(/unterminated/);
  });
});

const ROUND_TRIP = [
  "a#b",
  "a #b",
  "with space",
  " leading and trailing ",
  "x=y",
  "it's",
  'say "hi"',
  "$HOME",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: .env text
  "${VAR}",
  "$$",
  "\\$HOME",
  "back\\slash",
  "ends with\\",
  "ends with two\\\\",
  "\\n is not a newline",
  "\\0123",
  "''",
  "'",
  '"',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: .env text
  'it\'s $HOME and "${VAR}" \\ #x',
  "it's \\",
  "",
  "ünïcödé — 日本語 🚀",
  "\t tab",
];

describe("renderEnvFile", () => {
  it.each(ROUND_TRIP)("round-trips %j", (value) => {
    const file = renderEnvFile([{ name: "VALUE", value }], {}, REGISTRY);
    expect(parseDotenv(file)).toEqual({
      VALUE: value,
      DOCKER_REGISTRY: REGISTRY,
    });
  });

  it("round-trips random values over the risky characters", () => {
    const alphabet = ["a", " ", "#", "=", "'", '"', "$", "\\", "{", "}", "ü"];
    let seed = 42;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    for (let n = 0; n < 500; n++) {
      let value = "";
      const length = next() % 12;
      for (let i = 0; i < length; i++) {
        value += alphabet[next() % alphabet.length];
      }
      const file = renderEnvFile([{ name: "V", value }], {}, REGISTRY);
      expect(parseDotenv(file)).toEqual({
        V: value,
        DOCKER_REGISTRY: REGISTRY,
      });
    }
  });

  it("single-quotes plain values and double-quotes ones with ' or \\", () => {
    const file = renderEnvFile(
      [
        { name: "A", value: "$HOME #x" },
        { name: "B", value: "it's $x" },
        { name: "C", value: 'a\\b"' },
      ],
      {},
      REGISTRY
    );
    expect(file).toContain("A='$HOME #x'\n");
    expect(file).toContain('B="it\'s $$x"\n');
    expect(file).toContain('C="a\\\\b\\""\n');
  });

  it("starts with the header, sorts names, puts tags last, ends with a newline", () => {
    const file = renderEnvFile(
      [
        { name: "ZETA", value: "z" },
        { name: "ALPHA", value: "a" },
        { name: "MID_1", value: "m" },
      ],
      { WEB_TAG: "origin-main-def5678", IMAGE_TAG: "origin-main-abc1234" },
      REGISTRY
    );
    expect(file).toBe(
      [
        ENV_FILE_HEADER,
        "ALPHA='a'",
        "MID_1='m'",
        "ZETA='z'",
        `DOCKER_REGISTRY=${REGISTRY}`,
        "IMAGE_TAG=origin-main-abc1234",
        "WEB_TAG=origin-main-def5678",
        "",
      ].join("\n")
    );
    expect(parseDotenv(file)).toEqual({
      ALPHA: "a",
      MID_1: "m",
      ZETA: "z",
      DOCKER_REGISTRY: REGISTRY,
      IMAGE_TAG: "origin-main-abc1234",
      WEB_TAG: "origin-main-def5678",
    });
  });

  it("writes DOCKER_REGISTRY unquoted, just before the tag lines", () => {
    const file = renderEnvFile(
      [{ name: "A", value: "1" }],
      { IMAGE_TAG: "t1" },
      "registry.example.test:5000"
    );
    expect(file).toBe(
      `${ENV_FILE_HEADER}\nA='1'\nDOCKER_REGISTRY=registry.example.test:5000\nIMAGE_TAG=t1\n`
    );
  });

  it("rejects an invalid registry", () => {
    for (const bad of ["", "a b", "http://x", "x'y", "x\ny", "host:99999x"]) {
      expect(() => renderEnvFile([], {}, bad), bad).toThrow();
    }
  });

  it("still refuses a user variable named DOCKER_REGISTRY", () => {
    expect(() =>
      renderEnvFile([{ name: "DOCKER_REGISTRY", value: "evil" }], {}, REGISTRY)
    ).toThrow();
  });

  it("uses the exact header", () => {
    expect(ENV_FILE_HEADER).toBe(
      "# Managed by DSS Panel — edit variables in the Panel; local edits are overwritten on the next deploy."
    );
    expect(renderEnvFile([], {}, REGISTRY)).toBe(
      `${ENV_FILE_HEADER}\nDOCKER_REGISTRY=${REGISTRY}\n`
    );
  });

  it("rejects invalid names, values and tags, and a variable named like a tag", () => {
    expect(() =>
      renderEnvFile([{ name: "lower", value: "x" }], {}, REGISTRY)
    ).toThrow();
    expect(() =>
      renderEnvFile([{ name: "A", value: "x\ny" }], {}, REGISTRY)
    ).toThrow();
    expect(() =>
      renderEnvFile(
        [
          { name: "A", value: "1" },
          { name: "A", value: "2" },
        ],
        {},
        REGISTRY
      )
    ).toThrow();
    expect(() =>
      renderEnvFile(
        [{ name: "IMAGE_TAG", value: "x" }],
        { IMAGE_TAG: "t1" },
        REGISTRY
      )
    ).toThrow();
    expect(() => renderEnvFile([], { IMAGE_TAG: "a b" }, REGISTRY)).toThrow();
    expect(() =>
      renderEnvFile([], { IMAGE_TAG: "latest" }, REGISTRY)
    ).toThrow();
    expect(() => renderEnvFile([], { "bad name": "t1" }, REGISTRY)).toThrow();
  });

  it("refuses variables with a reserved prefix (rows saved before the rule)", () => {
    for (const name of ["COMPOSE_PROJECT_NAME", "DOCKER_HOST", "BUILDKIT_X"]) {
      expect(
        () => renderEnvFile([{ name, value: "x" }], {}, REGISTRY),
        name
      ).toThrow();
    }
  });

  it("writes COMPOSE_FILE after the header only when composeFiles is given", () => {
    const withOverlay = renderEnvFile(
      [{ name: "A", value: "1" }],
      {},
      REGISTRY,
      {
        composeFiles: ["compose.yaml", "compose.opsdeck.yaml"],
      }
    );
    expect(withOverlay.split("\n")[1]).toBe(
      "COMPOSE_FILE=compose.yaml:compose.opsdeck.yaml"
    );
    for (const out of [
      renderEnvFile([{ name: "A", value: "1" }], {}, REGISTRY),
      renderEnvFile([{ name: "A", value: "1" }], {}, REGISTRY, {}),
    ]) {
      expect(out).not.toContain("COMPOSE_FILE");
    }
  });

  it("refuses composeFiles that are empty or not plain file names", () => {
    for (const composeFiles of [[], ["a:b"], ["../x.yaml"], ["a b"], [""]]) {
      expect(() => renderEnvFile([], {}, REGISTRY, { composeFiles })).toThrow();
    }
  });

  it("still refuses a user variable named COMPOSE_FILE with the option given", () => {
    expect(() =>
      renderEnvFile([{ name: "COMPOSE_FILE", value: "x.yaml" }], {}, REGISTRY, {
        composeFiles: ["compose.yaml"],
      })
    ).toThrow();
  });
});

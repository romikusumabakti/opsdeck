/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: .env text */
import { describe, expect, it } from "vitest";
import { type DotenvEntry, parseDotenv } from "@/lib/variables/dotenv";
import { hasReservedPrefix } from "@/lib/variables/validation";

// Vectors follow compose-go v2.16.2 dotenv/parser.go and template/template.go
// (see lib/variables/dotenv.ts). Fixtures are fictional.

function entries(text: string): DotenvEntry[] {
  const result = parseDotenv(text);
  if ("error" in result) {
    throw new Error(`unexpected error on line ${result.error.line}`);
  }
  return result.entries;
}

function values(text: string): Record<string, string> {
  return Object.fromEntries(entries(text).map((e) => [e.name, e.value]));
}

function errorLine(text: string): number {
  const result = parseDotenv(text);
  if (!("error" in result)) throw new Error("expected an error");
  return result.error.line;
}

describe("parseDotenv statements", () => {
  it("reads NAME=value lines with line numbers", () => {
    expect(entries("A=1\n\n# note\nB=two\n")).toEqual([
      { name: "A", value: "1", line: 1, unresolvedRefs: [], duplicate: false },
      {
        name: "B",
        value: "two",
        line: 4,
        unresolvedRefs: [],
        duplicate: false,
      },
    ]);
  });

  it("accepts an export prefix and the yaml-style ':' separator", () => {
    expect(values("export A=1\nexport\tB = 2\nC: 3\nD:4\n")).toEqual({
      A: "1",
      B: "2",
      C: "3",
      D: "4",
    });
    // `export` without whitespace is part of the name.
    expect(values("exportX=1\n")).toEqual({ exportX: "1" });
  });

  it("skips blank lines, indented comments, CRLF and a BOM", () => {
    expect(values("\uFEFF  # c\r\n\r\nA=1\r\n   B=2\r\n")).toEqual({
      A: "1",
      B: "2",
    });
  });

  it("allows the name characters compose-go allows", () => {
    expect(values("a.b-c[0]_D=1\nnäme=2\n")).toEqual({
      "a.b-c[0]_D": "1",
      näme: "2",
    });
  });

  it("reads an empty value", () => {
    expect(values("A=\nB=   \nC=")).toEqual({ A: "", B: "", C: "" });
  });
});

describe("parseDotenv unquoted values", () => {
  it("cuts the value at ' #' only and trims trailing space", () => {
    expect(values("A=x #c\nB=y#z\nC=u\t#v\nD=  #w\nE=v   \nF=a=b\n")).toEqual({
      A: "x",
      B: "y#z",
      C: "u\t#v",
      D: "#w",
      E: "v",
      F: "a=b",
    });
  });

  it("keeps backslashes and quotes inside the value", () => {
    expect(values("A=a\\nb\nB=it's\nC=x\"y\n")).toEqual({
      A: "a\\nb",
      B: "it's",
      C: 'x"y',
    });
  });
});

describe("parseDotenv quoted values", () => {
  it("keeps single-quoted text literal", () => {
    expect(values("A='$HOME #x \\n'\nB='it\\'s'\n")).toEqual({
      A: "$HOME #x \\n",
      B: "it's",
    });
  });

  it("expands escapes in double quotes", () => {
    expect(
      values('A="a\\nb\\tc"\nB="q\\"q"\nC="b\\\\s"\nD="\\$X"\nE="\\0123"\n')
    ).toEqual({
      A: "a\nb\tc",
      B: 'q"q',
      C: "b\\s",
      D: "$X",
      E: "S",
    });
    // Not a supported escape: kept as is.
    expect(values('A="\\x41 \\c \\012"\n')).toEqual({ A: "\\x41 \\c \\012" });
  });

  it("reads multi-line quoted values and counts their lines", () => {
    const parsed = entries("A=\"one\ntwo\"\nB='x\ny'\nC=3\n");
    expect(parsed.map((e) => [e.name, e.value, e.line])).toEqual([
      ["A", "one\ntwo", 1],
      ["B", "x\ny", 3],
      ["C", "3", 5],
    ]);
  });

  it("ignores text after the closing quote up to a comment", () => {
    expect(values("A=\"x\" # note\nB='y'   \n")).toEqual({ A: "x", B: "y" });
  });
});

describe("parseDotenv interpolation", () => {
  it("resolves $$, $X and ${X} from earlier names", () => {
    const parsed = entries("A=1\nB=$A-${A}-$$A\nC=\"${A}x\"\nD='${A}'\n");
    expect(parsed.map((e) => [e.name, e.value])).toEqual([
      ["A", "1"],
      ["B", "1-1-$A"],
      ["C", "1x"],
      ["D", "${A}"],
    ]);
    expect(parsed.every((e) => e.unresolvedRefs.length === 0)).toBe(true);
  });

  it("leaves a lone $ and $<digit> alone", () => {
    expect(values("A=$ $1 x$\n")).toEqual({ A: "$ $1 x$" });
  });

  it("applies the default and alternative forms", () => {
    const text = [
      "SET=v",
      "EMPTY=",
      "A=${SET:-d}|${EMPTY:-d}|${NONE:-d}",
      "B=${SET-d}|${EMPTY-d}|${NONE-d}",
      "C=${SET:+alt}|${EMPTY:+alt}|${NONE:+alt}",
      "D=${SET+alt}|${EMPTY+alt}|${NONE+alt}",
      "E=${SET:?err}|${EMPTY?err}",
      "F=${NONE:-${SET}}|${SET:-x} ${SET}",
      "",
    ].join("\n");
    const parsed = values(text);
    expect(parsed.A).toBe("v|d|d");
    expect(parsed.B).toBe("v||d");
    expect(parsed.C).toBe("alt||");
    expect(parsed.D).toBe("alt|alt|");
    expect(parsed.E).toBe("v|");
    expect(parsed.F).toBe("v|v v");
  });

  it("matches names case-insensitively in the pattern, case-sensitively in lookup", () => {
    expect(values("a=1\nB=$a\n")).toEqual({ a: "1", B: "1" });
  });

  it("does not read later names or the shell, and flags unresolved refs", () => {
    const parsed = entries(
      'A=$LATER ${HOME} ${NONE:-d}\nB="$LATER"\nLATER=x\nC=$LATER\n'
    );
    expect(parsed.map((e) => [e.name, e.value, e.unresolvedRefs])).toEqual([
      ["A", "  d", ["LATER", "HOME", "NONE"]],
      ["B", "", ["LATER"]],
      ["LATER", "x", []],
      ["C", "x", []],
    ]);
  });

  it("lists each unresolved ref once", () => {
    expect(entries("A=$X$X${X}\n")[0]?.unresolvedRefs).toEqual(["X"]);
  });

  it("treats a required ref to a name not in the text as unresolved", () => {
    expect(entries("A=${NONE:?must be set}\n")[0]).toMatchObject({
      value: "",
      unresolvedRefs: ["NONE"],
    });
  });
});

describe("parseDotenv duplicates", () => {
  it("keeps the last definition, flagged, and interpolates in order", () => {
    const parsed = entries("A=1\nB=$A\nA=2\nC=$A\n");
    expect(parsed.map((e) => [e.name, e.value, e.line, e.duplicate])).toEqual([
      ["B", "1", 2, false],
      ["A", "2", 3, true],
      ["C", "2", 4, false],
    ]);
  });
});

describe("parseDotenv errors", () => {
  it("refuses an unterminated quote with the statement line", () => {
    expect(errorLine('A=1\nB="open\nC=2\n')).toBe(2);
    expect(errorLine("A='x\\'\n")).toBe(1);
  });

  it("refuses a statement without '=' or ':'", () => {
    expect(errorLine("A=1\nBARE\nC=2\n")).toBe(2);
    expect(errorLine("A=1\nBARE")).toBe(2);
  });

  it("refuses bad names", () => {
    expect(errorLine("A B=1\n")).toBe(1);
    expect(errorLine("A=1\n\nA$=1\n")).toBe(3);
    expect(errorLine("=x\n")).toBe(1);
  });

  it("refuses invalid templates and a required ref that is empty in the text", () => {
    expect(errorLine("A=${\n")).toBe(1);
    expect(errorLine("A=1\nB=${1x}\n")).toBe(2);
    expect(errorLine("E=\nA=${E:?must be set}\n")).toBe(2);
  });

  it("carries only the line, never the file text", () => {
    const secret = "s3cr3t-fictional-token";
    for (const text of [
      `TOKEN="${secret}`,
      `${secret} x=1`,
      `TOKEN=\${!${secret}}\nX=\n`,
      `E=\nTOKEN=\${E:?${secret}}`,
    ]) {
      const result = parseDotenv(text);
      expect(Object.keys(result)).toEqual(["error"]);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).toMatch(/^\{"error":\{"line":\d+\}\}$/);
    }
  });
});

describe("COMPOSE_PROFILES", () => {
  it("is exempt from the reserved COMPOSE_ prefix; COMPOSE_FILE is not", () => {
    expect(hasReservedPrefix("COMPOSE_PROFILES")).toBe(false);
    expect(hasReservedPrefix("COMPOSE_FILE")).toBe(true);
    expect(hasReservedPrefix("COMPOSE_PROJECT_NAME")).toBe(true);
    expect(hasReservedPrefix("COMPOSE_PROFILES_X")).toBe(true);
  });
});

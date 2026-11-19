import type { VariableKind } from "@/lib/db/schema";
import type { DotenvEntry } from "@/lib/variables/dotenv";
import {
  isReservedVariableName,
  VARIABLE_VALUE_MAX_LENGTH,
  variableNameSchema,
} from "@/lib/variables/validation";

// The pure half of "Import .env" (pasted, uploaded or read from the deploy
// dirs): the review rows a parsed file proposes, and the values a save may
// write. Pure and client-safe. The rows carry a value only for a row proposed
// plain; every other value stays in `values`, which the service never sends.

/** The most UTF-8 bytes of pasted or uploaded text accepted (as the server read). */
export const IMPORT_TEXT_MAX_BYTES = 256 * 1024;
/** The most entries a pasted or uploaded text may define. */
export const IMPORT_TEXT_MAX_ENTRIES = 1000;

export type ImportState = "new" | "same" | "conflict" | "unimportable";

export type ImportUnimportableReason =
  | "invalidName"
  | "multiLine"
  | "tooLong"
  /** A NUL character (the `.env` format cannot carry one). */
  | "invalidValue"
  | "escrowed";

export type ImportSkipReason = "tagVariable" | "dockerRegistry" | "reserved";

export type ImportSource = {
  serverName: string;
  deployDir: string;
  /** Opaque: picks this dir's value on save. */
  valueId: string;
  /** This dir's value, only on a row proposed plain. */
  value?: string;
};

export type ImportRow = {
  name: string;
  proposedKind: VariableKind;
  /**
   * The value, only for an importable row proposed plain whose dirs agree;
   * else null (secrets never leave the server in clear).
   */
  value: string | null;
  /** The dirs defining the name (server source only). */
  sources?: ImportSource[];
  state: ImportState;
  reason?: ImportUnimportableReason;
  flags: {
    differsAcrossDirs?: true;
    unresolvedRefs?: string[];
    duplicate?: true;
  };
};

/** A parsed file: a deploy dir's `.env`, or pasted text (no `dir`). */
export type ImportFile = {
  dir?: { serverName: string; deployDir: string; fingerprint: string };
  entries: readonly DotenvEntry[];
};

/** A stored variable, its value decrypted (server-side only). */
export type ImportExisting = {
  kind: VariableKind;
  value: string;
  escrow: boolean;
};

export type ImportTemplate = { kind: VariableKind; escrow: boolean };

/** A review row with what the save needs. Server-side only. */
export type PlannedImportRow = {
  row: ImportRow;
  /** valueId → value; text has one value under "". */
  values: Map<string, string>;
  /** Whether a write of this row is escrowed. */
  escrow: boolean;
  /** Whether a write replaces a stored variable. */
  overwrites: boolean;
};

const SECRET_WORDS =
  /PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|CREDENTIAL|PRIVATE|APIKEY|ACCESS_KEY|SIGNING/;
const SECRET_SEGMENTS = new Set(["KEY", "PASS", "PWD", "SALT", "DSN", "CERT"]);
// `scheme://user:pass@` (the user may be empty: `redis://:pass@`).
const URL_CREDENTIALS = /:\/\/[^\s/?#@:]*:[^\s/?#@]+@/;

/**
 * Whether a variable is likely a secret, by its name or a value with URL
 * credentials. Errs toward secret: the user downgrades a row in review.
 */
export function looksSecret(name: string, value: string): boolean {
  const upper = name.toUpperCase();
  return (
    SECRET_WORDS.test(upper) ||
    upper.split("_").some((segment) => SECRET_SEGMENTS.has(segment)) ||
    URL_CREDENTIALS.test(value)
  );
}

function skipReason(
  name: string,
  tagNames: readonly string[]
): ImportSkipReason | null {
  if (tagNames.includes(name)) return "tagVariable";
  if (name === "DOCKER_REGISTRY") return "dockerRegistry";
  if (isReservedVariableName(name)) return "reserved";
  return null;
}

function valueIssue(value: string): ImportUnimportableReason | null {
  if (/[\n\r]/.test(value)) return "multiLine";
  if (value.length > VARIABLE_VALUE_MAX_LENGTH) return "tooLong";
  if (value.includes("\0")) return "invalidValue";
  return null;
}

type Candidate = { source?: ImportSource; entry: DotenvEntry };

/**
 * The review rows of the parsed files, sorted by name, and the names left
 * out (tag variables, DOCKER_REGISTRY, reserved prefixes), once each.
 * Several files are the dirs of one environment: a name whose dirs disagree
 * is flagged `differsAcrossDirs`.
 */
export function planImportRows({
  files,
  existing,
  templates,
  tagNames,
}: {
  files: readonly ImportFile[];
  existing: ReadonlyMap<string, ImportExisting>;
  templates: ReadonlyMap<string, ImportTemplate>;
  tagNames: readonly string[];
}): {
  rows: PlannedImportRow[];
  skipped: { name: string; reason: ImportSkipReason }[];
} {
  const byName = new Map<string, Candidate[]>();
  const skipped = new Map<string, ImportSkipReason>();
  for (const file of files) {
    for (const entry of file.entries) {
      const reason = skipReason(entry.name, tagNames);
      if (reason) {
        skipped.set(entry.name, reason);
        continue;
      }
      const source = file.dir && {
        serverName: file.dir.serverName,
        deployDir: file.dir.deployDir,
        valueId: `${file.dir.fingerprint}:${entry.line}`,
      };
      const list = byName.get(entry.name) ?? [];
      list.push({ source, entry });
      byName.set(entry.name, list);
    }
  }

  const rows = [...byName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, candidates]) =>
      planRow(name, candidates, {
        existing: existing.get(name),
        template: templates.get(name),
        tagNames,
      })
    );
  return {
    rows,
    skipped: [...skipped.entries()]
      .map(([name, reason]) => ({ name, reason }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

function planRow(
  name: string,
  candidates: Candidate[],
  {
    existing,
    template,
    tagNames,
  }: {
    existing: ImportExisting | undefined;
    template: ImportTemplate | undefined;
    tagNames: readonly string[];
  }
): PlannedImportRow {
  const distinct = [...new Set(candidates.map((c) => c.entry.value))];
  const differs = distinct.length > 1;
  const proposedKind: VariableKind =
    existing?.kind ??
    template?.kind ??
    (distinct.some((value) => looksSecret(name, value)) ? "secret" : "plain");

  let state: ImportState;
  let reason: ImportUnimportableReason | undefined;
  const issue = distinct.map(valueIssue).find((r) => r !== null);
  if (!variableNameSchema(tagNames).safeParse(name).success) {
    state = "unimportable";
    reason = "invalidName";
  } else if (issue) {
    state = "unimportable";
    reason = issue;
  } else if (!existing) {
    state = "new";
  } else if (distinct.every((value) => value === existing.value)) {
    state = "same";
  } else if (existing.escrow) {
    state = "unimportable";
    reason = "escrowed";
  } else {
    state = "conflict";
  }

  const shown = proposedKind === "plain" && state !== "unimportable";
  const unresolved = [
    ...new Set(candidates.flatMap((c) => c.entry.unresolvedRefs)),
  ].sort();
  const flags: ImportRow["flags"] = {};
  if (differs) flags.differsAcrossDirs = true;
  if (unresolved.length > 0) flags.unresolvedRefs = unresolved;
  if (candidates.some((c) => c.entry.duplicate)) flags.duplicate = true;

  const row: ImportRow = {
    name,
    proposedKind,
    value: shown && !differs ? (distinct[0] ?? null) : null,
    state,
    flags,
  };
  if (reason) row.reason = reason;
  const values = new Map<string, string>();
  const sources: ImportSource[] = [];
  for (const { source, entry } of candidates) {
    if (!source) {
      values.set("", entry.value);
      continue;
    }
    values.set(source.valueId, entry.value);
    sources.push(shown ? { ...source, value: entry.value } : source);
  }
  if (sources.length > 0) row.sources = sources;

  return {
    row,
    values,
    escrow: existing ? existing.escrow : (template?.escrow ?? false),
    overwrites: existing !== undefined,
  };
}

/** One row of a save request. */
export type ImportRequestRow = {
  name: string;
  kind: VariableKind;
  /** The chosen dir's value (server source); required when dirs differ. */
  valueId?: string;
};

export type ImportWrite = {
  name: string;
  kind: VariableKind;
  /** In clear: the service encrypts it. */
  value: string;
  escrow: boolean;
  overwrites: boolean;
};

export type ImportIssueCode =
  | "importRowUnknown"
  | "importRowDuplicate"
  | "importRowSame"
  | "importRowUnimportable"
  | "importSourceRequired"
  | "importSourceUnknown";

export type ImportIssue = {
  code: ImportIssueCode;
  name: string;
  reason?: ImportUnimportableReason;
};

/**
 * The writes a save request asks for, re-validated against freshly planned
 * rows, or the first refusal: an unknown or repeated name, a `same` or
 * `unimportable` row, a missing or unknown dir choice.
 */
export function selectImportWrites(
  planned: readonly PlannedImportRow[],
  requested: readonly ImportRequestRow[]
): { writes: ImportWrite[] } | { issue: ImportIssue } {
  const byName = new Map(planned.map((p) => [p.row.name, p]));
  const seen = new Set<string>();
  const writes: ImportWrite[] = [];
  for (const request of requested) {
    const { name } = request;
    const found = byName.get(name);
    if (!found) return { issue: { code: "importRowUnknown", name } };
    if (seen.has(name)) return { issue: { code: "importRowDuplicate", name } };
    seen.add(name);
    const { row } = found;
    if (row.state === "same") return { issue: { code: "importRowSame", name } };
    if (row.state === "unimportable") {
      return {
        issue: { code: "importRowUnimportable", name, reason: row.reason },
      };
    }

    let value: string | undefined;
    if (request.valueId !== undefined) {
      value = row.sources ? found.values.get(request.valueId) : undefined;
      if (value === undefined) {
        return { issue: { code: "importSourceUnknown", name } };
      }
    } else if (row.flags.differsAcrossDirs) {
      return { issue: { code: "importSourceRequired", name } };
    } else {
      value = found.values.values().next().value;
    }
    if (value === undefined) {
      return { issue: { code: "importSourceUnknown", name } };
    }
    writes.push({
      name,
      kind: request.kind,
      value,
      escrow: found.escrow,
      overwrites: found.overwrites,
    });
  }
  return { writes };
}

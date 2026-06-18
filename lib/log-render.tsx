import Anser from "anser";
import type * as React from "react";
import { cn } from "@/lib/utils";

export type LogLevel = "error" | "warn" | "info" | "debug" | null;

// Match common level tokens in the first ~200 chars of a line (where log
// prefixes live). Word-boundary on both sides so substrings inside paths
// (e.g. `/var/log/error.log`) don't trigger.
const LEVEL_PATTERNS: Array<{ level: NonNullable<LogLevel>; re: RegExp }> = [
  { level: "error", re: /\b(?:ERROR|ERR|FATAL|PANIC|CRITICAL)\b/ },
  { level: "warn", re: /\b(?:WARN|WARNING)\b/ },
  { level: "info", re: /\b(?:INFO|NOTICE)\b/ },
  { level: "debug", re: /\b(?:DEBUG|TRACE|VERBOSE)\b/ },
];

export function detectLogLevel(line: string): LogLevel {
  const head = line.length > 200 ? line.slice(0, 200) : line;
  for (const { level, re } of LEVEL_PATTERNS) {
    if (re.test(head)) return level;
  }
  return null;
}

// --- Structured (JSON) log parsing ----------------------------------------
//
// Many services emit one JSON object per line (pino, bunyan, zap, logrus,
// zerolog, slog, …). Log shippers (Fluent Bit, Vector, Promtail, …) often
// wrap each line in an envelope of `{ timestamp, labels, line }`, where the
// inner `line` is itself the original — frequently JSON — log line. We
// normalise all of these into a common shape so the viewer can show
// timestamp / level / message / fields instead of an opaque blob, while
// leaving plain-text lines untouched.

export type ParsedLog = {
  // True when the line was successfully parsed as a structured JSON object.
  structured: boolean;
  level: LogLevel;
  timestamp: string | null;
  message: string;
  // Remaining key/value pairs, already stringified for display.
  fields: Array<[string, string]>;
  // The original line, verbatim — used for filter / copy / download.
  raw: string;
};

// Field-name aliases, lowercased. First match wins.
const LEVEL_KEYS = [
  "level",
  "lvl",
  "severity",
  "loglevel",
  "levelname",
  "log.level",
  "@level",
];
const MESSAGE_KEYS = [
  "msg",
  "message",
  "body",
  "event",
  "@message",
  "line",
  "log",
  "text",
];
const TIMESTAMP_KEYS = [
  "ts",
  "time",
  "timestamp",
  "@timestamp",
  "_time",
  "eventtime",
  "t",
];
// Shipper-envelope label container.
const LABEL_KEYS = ["labels", "stream"];

// Map a numeric level to our buckets. Covers pino/bunyan (10/20/30/40/50/60)
// and syslog severity (0–7) — small numbers fall through to the syslog scale.
function numericLevel(n: number): LogLevel {
  if (!Number.isFinite(n)) return null;
  if (n >= 50) return "error";
  if (n >= 40) return "warn";
  if (n >= 30) return "info";
  if (n >= 10) return "debug";
  if (n <= 3) return "error"; // syslog emerg/alert/crit/err
  if (n === 4) return "warn"; // syslog warning
  if (n <= 6) return "info"; // syslog notice/info
  return "debug"; // syslog debug + 7..9
}

function normalizeLevel(value: unknown): LogLevel {
  if (value == null) return null;
  if (typeof value === "number") return numericLevel(value);
  const s = String(value).trim().toLowerCase();
  if (s === "") return null;
  if (/^\d+$/.test(s)) return numericLevel(Number(s));
  if (/^(err|error|fatal|panic|crit|emerg|alert|severe)/.test(s))
    return "error";
  if (/^warn/.test(s)) return "warn";
  if (/^(info|notice)/.test(s)) return "info";
  if (/^(debug|trace|verbose|fine)/.test(s)) return "debug";
  return null;
}

function stringifyValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// Build a lowercased index of own keys so alias lookups are case-insensitive.
function lowerIndex(obj: Record<string, unknown>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const key of Object.keys(obj)) {
    const lk = key.toLowerCase();
    if (!idx.has(lk)) idx.set(lk, key);
  }
  return idx;
}

function pick(
  obj: Record<string, unknown>,
  idx: Map<string, string>,
  aliases: string[]
): { key: string; value: unknown } | null {
  for (const alias of aliases) {
    if (alias.includes(".")) {
      const [head, tail] = alias.split(".");
      const realHead = idx.get(head);
      if (realHead) {
        const nested = obj[realHead];
        if (nested && typeof nested === "object" && !Array.isArray(nested)) {
          const nIdx = lowerIndex(nested as Record<string, unknown>);
          const realTail = nIdx.get(tail);
          if (realTail) {
            return {
              key: realHead,
              value: (nested as Record<string, unknown>)[realTail],
            };
          }
        }
      }
      continue;
    }
    const real = idx.get(alias);
    if (real !== undefined) return { key: real, value: obj[real] };
  }
  return null;
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  if (trimmed[0] !== "{" || trimmed[trimmed.length - 1] !== "}") return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON — fall through to text handling
  }
  return null;
}

// Extract level/timestamp/message/fields from an already-parsed object.
function extractFromObject(
  obj: Record<string, unknown>,
  raw: string
): ParsedLog {
  const idx = lowerIndex(obj);
  const consumed = new Set<string>();

  const levelHit = pick(obj, idx, LEVEL_KEYS);
  if (levelHit) consumed.add(levelHit.key);
  const tsHit = pick(obj, idx, TIMESTAMP_KEYS);
  if (tsHit) consumed.add(tsHit.key);
  const msgHit = pick(obj, idx, MESSAGE_KEYS);
  if (msgHit) consumed.add(msgHit.key);

  let level = normalizeLevel(levelHit?.value);
  let message = msgHit ? stringifyValue(msgHit.value) : "";
  const timestamp = tsHit ? stringifyValue(tsHit.value) : null;

  // Shipper envelope: the meaningful payload lives in `line`, which is
  // frequently itself a JSON log line. Recurse one level so we surface the
  // inner level/message and keep the envelope labels as fields.
  const fields: Array<[string, string]> = [];
  if (msgHit && (msgHit.key === "line" || msgHit.key === "log")) {
    const inner = tryParseObject(message);
    if (inner) {
      const innerParsed = extractFromObject(inner, message);
      if (innerParsed.level) level = innerParsed.level;
      message = innerParsed.message || message;
      fields.push(...innerParsed.fields);
    }
  }

  for (const key of Object.keys(obj)) {
    if (consumed.has(key)) continue;
    // Spread structured label maps into individual chips.
    if (LABEL_KEYS.includes(key.toLowerCase())) {
      const labels = obj[key];
      if (labels && typeof labels === "object" && !Array.isArray(labels)) {
        for (const [lk, lv] of Object.entries(
          labels as Record<string, unknown>
        )) {
          fields.push([lk, stringifyValue(lv)]);
        }
        continue;
      }
    }
    fields.push([key, stringifyValue(obj[key])]);
  }

  // Fall back to token-sniffing the message if no explicit level field.
  if (!level && message) level = detectLogLevel(message);

  return {
    structured: true,
    level,
    timestamp,
    message,
    fields,
    raw,
  };
}

export function parseLogLine(raw: string): ParsedLog {
  let obj = tryParseObject(raw);
  let prefix = "";
  if (!obj) {
    // Container runtimes prepend a timestamp/stream marker before the app's
    // JSON payload (`docker logs -t`, CRI `<ts> stdout F <json>`, journald).
    // Strip everything up to the first `{` and retry — tryParseObject still
    // validates the trailing `}`, so a plain line containing a stray `{`
    // won't be misread as JSON.
    const brace = raw.indexOf("{");
    if (brace > 0) {
      const parsed = tryParseObject(raw.slice(brace));
      if (parsed) {
        obj = parsed;
        prefix = raw.slice(0, brace).trim();
      }
    }
  }
  if (obj) {
    const result = extractFromObject(obj, raw);
    // Fall back to the stripped runtime timestamp when the payload had none.
    if (!result.timestamp && prefix) result.timestamp = prefix;
    return result;
  }
  return {
    structured: false,
    level: detectLogLevel(raw),
    timestamp: null,
    message: raw,
    fields: [],
    raw,
  };
}

// Convert a single log line containing ANSI SGR escape codes into React nodes.
// We use anser's JSON output and re-emit spans with inline styles — that lets
// us scope colors to this component without injecting a stylesheet and without
// trusting innerHTML.
export function renderAnsiLine(line: string): React.ReactNode[] {
  if (!line.includes("\x1b")) return [line];
  const segments = Anser.ansiToJson(line, {
    json: true,
    remove_empty: true,
    use_classes: false,
  });
  return segments.map((seg, i) => {
    const style: React.CSSProperties = {};
    if (seg.fg) style.color = `rgb(${seg.fg})`;
    if (seg.bg) style.backgroundColor = `rgb(${seg.bg})`;
    const decorations = seg.decorations ?? [];
    if (decorations.includes("bold")) style.fontWeight = 600;
    if (decorations.includes("underline")) style.textDecoration = "underline";
    if (decorations.includes("italic")) style.fontStyle = "italic";
    if (decorations.includes("dim")) style.opacity = 0.7;
    if (Object.keys(style).length === 0) return seg.content;
    return (
      <span key={i} style={style}>
        {seg.content}
      </span>
    );
  });
}

const LEVEL_BADGE: Record<NonNullable<LogLevel>, string> = {
  error: "text-destructive",
  warn: "text-amber-500",
  info: "text-sky-500",
  debug: "text-muted-foreground",
};

// OpenTelemetry semantic-convention fields get first-class rendering instead
// of generic key=value chips. Keys are matched after stripping case and any
// `.`/`_` separators, so `service.name`, `service_name` and `serviceName` all
// collapse to the same identity.
const TRACE_KEYS = new Set(["traceid", "spanid", "correlationid"]);

function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Trace/span/correlation ids are long and noisy — show a head fragment with
// the full value available on hover.
function shortenId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

type ClassifiedFields = {
  serviceName: string | null;
  serviceVersion: string | null;
  trace: Array<[string, string]>;
  rest: Array<[string, string]>;
};

function classifyFields(fields: Array<[string, string]>): ClassifiedFields {
  let serviceName: string | null = null;
  let serviceVersion: string | null = null;
  const trace: Array<[string, string]> = [];
  const rest: Array<[string, string]> = [];
  for (const [key, value] of fields) {
    const n = normKey(key);
    if (n === "servicename") serviceName = value;
    else if (n === "serviceversion") serviceVersion = value;
    else if (TRACE_KEYS.has(n)) trace.push([key, value]);
    else rest.push([key, value]);
  }
  // A bare version with no name isn't a service identity — keep it generic.
  if (serviceVersion && !serviceName) {
    rest.unshift(["service.version", serviceVersion]);
    serviceVersion = null;
  }
  return { serviceName, serviceVersion, trace, rest };
}

// Render the body of a single log row. In `pretty` mode a structured line is
// laid out as timestamp · level · service · message · trace · key=value chips
// (OpenTelemetry semantic-convention fields first); otherwise the raw line is
// shown verbatim (with ANSI colors).
export function LogContent({
  parsed,
  pretty,
}: {
  parsed: ParsedLog;
  pretty: boolean;
}) {
  if (!pretty || !parsed.structured) {
    return <>{renderAnsiLine(parsed.raw)}</>;
  }
  const { serviceName, serviceVersion, trace, rest } = classifyFields(
    parsed.fields
  );
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {parsed.timestamp && (
        <span className="text-muted-foreground/70 shrink-0 tabular-nums">
          {parsed.timestamp}
        </span>
      )}
      {parsed.level && (
        <span
          className={cn(
            "shrink-0 font-semibold uppercase",
            LEVEL_BADGE[parsed.level]
          )}
        >
          {parsed.level}
        </span>
      )}
      {serviceName && (
        <span className="shrink-0 rounded bg-muted px-1.5 font-medium text-foreground/80">
          {serviceName}
          {serviceVersion && (
            <span className="text-muted-foreground/70"> v{serviceVersion}</span>
          )}
        </span>
      )}
      {parsed.message && (
        <span className="text-foreground">
          {renderAnsiLine(parsed.message)}
        </span>
      )}
      {trace.map(([key, value]) => (
        <span
          key={key}
          className="text-muted-foreground/60"
          title={`${key}=${value}`}
        >
          {key}={shortenId(value)}
        </span>
      ))}
      {rest.map(([key, value]) => (
        <span key={key} className="text-muted-foreground">
          <span className="text-muted-foreground/60">{key}=</span>
          {value}
        </span>
      ))}
    </span>
  );
}

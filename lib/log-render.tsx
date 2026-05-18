import Anser from "anser";
import type * as React from "react";

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

"use client";

import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type MentionUser = { id: string; name: string };

// A textarea that offers an `@`-mention autocomplete. It only helps the author
// type an exact display name; the server resolves who was mentioned by scanning
// the saved body for `@${name}` (see actions/issues#addComment), so nothing here
// needs to track ids.
export function MentionTextarea({
  value,
  onChange,
  users,
  placeholder,
  rows,
}: {
  value: string;
  onChange: (v: string) => void;
  users: MentionUser[];
  placeholder?: string;
  rows?: number;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  // The active `@query` (text after the nearest `@`), or null when not mentioning.
  const [query, setQuery] = React.useState<string | null>(null);
  const [active, setActive] = React.useState(0);

  const matches = React.useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return users.filter((u) => u.name.toLowerCase().includes(q)).slice(0, 6);
  }, [query, users]);

  function detect(el: HTMLTextAreaElement) {
    const before = el.value.slice(0, el.selectionStart);
    const m = before.match(/@([^\n@]{0,40})$/);
    setQuery(m ? m[1] : null);
    setActive(0);
  }

  function insert(name: string) {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = el.value.slice(0, caret);
    const after = el.value.slice(caret);
    const m = before.match(/@([^\n@]{0,40})$/);
    if (!m) return;
    const start = before.length - m[0].length;
    const next = `${before.slice(0, start)}@${name} ${after}`;
    onChange(next);
    setQuery(null);
    const pos = start + name.length + 2; // after "@name "
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (query === null || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      insert(matches[active].name);
    } else if (e.key === "Escape") {
      setQuery(null);
    }
  }

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target);
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => detect(e.currentTarget)}
        onBlur={() => setQuery(null)}
        placeholder={placeholder}
        rows={rows}
      />
      {query !== null && matches.length > 0 ? (
        <ul className="absolute z-10 mt-1 w-56 rounded-md border bg-popover p-1 shadow-md">
          {matches.map((u, i) => (
            <li key={u.id}>
              <button
                type="button"
                // onMouseDown (not onClick) so it fires before the textarea blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  insert(u.name);
                }}
                className={cn(
                  "flex w-full items-center rounded px-2 py-1.5 text-start text-sm",
                  i === active && "bg-accent"
                )}
              >
                @{u.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

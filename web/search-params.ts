// The router's query-string codec. TanStack's default parses values as JSON
// (`?n=1` becomes the number 1, and the string "1" is written back as
// `?n=%221%22`), which would change URLs the app has always written as plain
// `?status=open&page=2` and that pages read with URLSearchParams. This keeps
// every value a string — a repeated key becomes a string array — so a URL
// round-trips unchanged.

export type SearchRecord = Record<string, string | string[]>;

export function parseSearch(search: string): SearchRecord {
  const out: SearchRecord = {};
  for (const [key, value] of new URLSearchParams(search)) {
    const previous = out[key];
    out[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return out;
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      params.append(key, String(item));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

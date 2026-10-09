"use client";

import type { UserCardData } from "@/lib/types";

// One in-flight or settled request per user, reused for 60 s, so hovering the
// same name across a list costs one fetch. Failures are evicted so the next
// hover retries.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; promise: Promise<UserCardData> }>();

export function loadUserCard(id: string): Promise<UserCardData> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = fetch(`/api/users/${id}/card`).then((res) => {
    if (!res.ok) throw new Error(`card ${res.status}`);
    return res.json() as Promise<UserCardData>;
  });
  promise.catch(() => cache.delete(id));
  cache.set(id, { at: Date.now(), promise });
  return promise;
}

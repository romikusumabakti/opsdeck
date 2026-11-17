// Deterministic stand-ins for randomness in the demo seed: the same stable
// string always yields the same numbers, so two runs (and the tests) plan the
// same history.
import { createHash } from "node:crypto";

/** A fake 40-hex commit SHA derived from a stable string. */
export function fakeSha(seed: string): string {
  return createHash("sha1").update(`menara-demo:${seed}`).digest("hex");
}

/** mulberry32 seeded by the first 32 bits of the seed's SHA-256. */
export function prng(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [min, max] from a generator. */
export function between(next: () => number, min: number, max: number): number {
  return min + Math.floor(next() * (max - min + 1));
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * `daysAgo` days before `now`, at `minuteOfDay` minutes past 02:00 UTC
 * (09:00 in Asia/Jakarta, the staff's working day). Never later than three
 * hours before `now`, so what follows it (a deploy, a rollback) still lands
 * in the past.
 */
export function workTime(now: Date, daysAgo: number, minuteOfDay = 0): Date {
  const day = new Date(now.getTime() - daysAgo * DAY);
  day.setUTCHours(2, 0, 0, 0);
  const at = day.getTime() + minuteOfDay * MINUTE;
  return new Date(Math.min(at, now.getTime() - 180 * MINUTE));
}

export const addMinutes = (date: Date, minutes: number): Date =>
  new Date(date.getTime() + minutes * MINUTE);

export const addSeconds = (date: Date, seconds: number): Date =>
  new Date(date.getTime() + seconds * 1000);

export const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * DAY);

/** `date`, or one minute before `now` when it would land later. */
export const notAfter = (date: Date, now: Date): Date =>
  date.getTime() < now.getTime() - MINUTE
    ? date
    : new Date(now.getTime() - MINUTE);

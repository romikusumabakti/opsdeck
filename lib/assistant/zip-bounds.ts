import { createInflateRaw } from "node:zlib";

/**
 * A Word document or workbook is a ZIP, and the libraries that read them
 * (mammoth, exceljs) inflate every part in memory. Before they do, the ZIP
 * is checked here: its central directory must declare a bounded package
 * (ZIP_MAX_TOTAL_BYTES in all, no entry inflating more than
 * ZIP_MAX_RATIO times its size past ZIP_RATIO_FLOOR_BYTES, at most
 * ZIP_MAX_ENTRIES parts), and each part's deflate stream is then inflated
 * (counted, not kept) to prove it does not inflate past what the directory
 * declares, so a directory that lies is caught too.
 */

export const ZIP_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const ZIP_MAX_RATIO = 100;
export const ZIP_RATIO_FLOOR_BYTES = 10 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 10_000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;

type Entry = {
  method: number;
  encrypted: boolean;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

/** The central directory's entries, or null when it cannot be read. */
function centralDirectory(bytes: Uint8Array): Entry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record sits in the last 22 bytes plus a comment of ≤ 64 KiB.
  const lowest = Math.max(0, bytes.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= lowest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  const offset = view.getUint32(eocd + 16, true);
  // ZIP64 (sentinel values): an Office file of this size never needs it.
  if (count === 0xffff || offset === ZIP64_SENTINEL) return null;
  if (count > ZIP_MAX_ENTRIES) return null;

  const entries: Entry[] = [];
  let at = offset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.byteLength) return null;
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) return null;
    const entry = {
      encrypted: (view.getUint16(at + 8, true) & 1) === 1,
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      uncompressedSize: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    };
    if (
      entry.compressedSize === ZIP64_SENTINEL ||
      entry.uncompressedSize === ZIP64_SENTINEL
    ) {
      return null;
    }
    entries.push(entry);
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  return entries;
}

/** The part's compressed bytes, from its local header. */
function entryData(bytes: Uint8Array, entry: Entry): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (at + 30 > bytes.byteLength) return null;
  if (view.getUint32(at, true) !== LOCAL_SIGNATURE) return null;
  const start =
    at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) return null;
  return bytes.subarray(start, end);
}

/** Inflates `data`, counting; false once it passes `limit` bytes. */
function inflatesWithin(data: Uint8Array, limit: number): Promise<boolean> {
  return new Promise((resolve) => {
    const inflate = createInflateRaw();
    let total = 0;
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      inflate.destroy();
      resolve(ok);
    };
    inflate.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limit) settle(false);
    });
    inflate.on("error", () => settle(false));
    inflate.on("end", () => settle(total <= limit));
    inflate.end(data);
  });
}

/** True when the ZIP is within the bounds above; false otherwise. */
export async function zipWithinBounds(bytes: Uint8Array): Promise<boolean> {
  const entries = centralDirectory(bytes);
  if (!entries) return false;
  let total = 0;
  for (const entry of entries) {
    if (entry.encrypted || (entry.method !== 0 && entry.method !== 8)) {
      return false;
    }
    total += entry.uncompressedSize;
    if (total > ZIP_MAX_TOTAL_BYTES) return false;
    if (
      entry.uncompressedSize > ZIP_RATIO_FLOOR_BYTES &&
      entry.uncompressedSize > ZIP_MAX_RATIO * Math.max(1, entry.compressedSize)
    ) {
      return false;
    }
  }
  for (const entry of entries) {
    const data = entryData(bytes, entry);
    if (!data) return false;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) return false;
      continue;
    }
    if (!(await inflatesWithin(data, entry.uncompressedSize))) return false;
  }
  return true;
}

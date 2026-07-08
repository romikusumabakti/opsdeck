import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Human-readable byte size (base-1024): 0 → "0 B", 1536 → "1.5 KB". Keeps one
// decimal for KB and up, trims a trailing ".0", and clamps to the largest unit.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** i;
  const rounded =
    i === 0 ? String(bytes) : value.toFixed(1).replace(/\.0$/, "");
  return `${rounded} ${units[i]}`;
}

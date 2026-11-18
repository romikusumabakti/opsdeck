/**
 * What a question's uploaded files may be, shared by the upload route and the
 * question box (client-safe: no server imports). The type is decided by the
 * bytes; the name's extension must agree with them, so a ZIP named `.png` or
 * a script named `.pdf` is refused.
 */

/** Files one question may carry. */
export const MAX_UPLOADS_PER_QUESTION = 10;

export const MiB = 1024 * 1024;

/** Per-kind size limits (bytes). */
export const UPLOAD_LIMITS = {
  image: 5 * MiB,
  pdf: 15 * MiB,
  other: 20 * MiB,
} as const;

/** The most characters of a file's text the model reads (read_upload). */
export const MAX_UPLOAD_TEXT_CHARS = 100_000;

/** The largest file of any kind; the upload route's body limit is above it. */
export const MAX_UPLOAD_BYTES = UPLOAD_LIMITS.other;

export type UploadKind = "image" | "pdf" | "docx" | "xlsx" | "text";

export type SniffedUpload = { kind: UploadKind; mediaType: string };

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const TEXT_EXTENSIONS = [
  "txt",
  "text",
  "log",
  "md",
  "markdown",
  "json",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "xml",
  "toml",
  "ini",
  "properties",
  "sql",
  "html",
  "css",
  "js",
  "jsx",
  "mjs",
  "ts",
  "tsx",
  "java",
  "kt",
  "py",
  "go",
  "rs",
  "rb",
  "php",
  "cs",
  "c",
  "h",
  "cpp",
  "sh",
  "diff",
  "patch",
];

/** For the file picker's `accept`: every extension a question takes. */
export const UPLOAD_ACCEPT = [
  ...IMAGE_EXTENSIONS,
  "pdf",
  "docx",
  "xlsx",
  ...TEXT_EXTENSIONS,
]
  .map((ext) => `.${ext}`)
  .join(",");

export const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const TEXT_MEDIA_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};

function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The kind a file name claims, or null for a name no question takes. */
export function claimedKind(filename: string): UploadKind | null {
  const ext = extensionOf(filename);
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx") return "xlsx";
  if (TEXT_EXTENSIONS.includes(ext)) return "text";
  return null;
}

/** The size limit of a kind. */
export function uploadLimit(kind: UploadKind): number {
  if (kind === "image") return UPLOAD_LIMITS.image;
  if (kind === "pdf") return UPLOAD_LIMITS.pdf;
  return UPLOAD_LIMITS.other;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function imageType(b: Uint8Array): string | null {
  if (b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(b, 0, 4) === "GIF8") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/**
 * The OOXML package a ZIP is, by the part names stored in its headers
 * (uncompressed, so a byte search finds them): a Word document has
 * `word/document.xml`, a workbook `xl/workbook.xml`. Any other ZIP is not.
 */
function officeKind(bytes: Uint8Array): "docx" | "xlsx" | null {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03)) {
    return null;
  }
  const latin1 = new TextDecoder("latin1").decode(bytes);
  const hasContentTypes = latin1.includes("[Content_Types].xml");
  if (hasContentTypes && latin1.includes("word/document.xml")) return "docx";
  if (hasContentTypes && latin1.includes("xl/workbook.xml")) return "xlsx";
  return null;
}

/** UTF-8 text without NUL bytes (a binary file decodes to garbage or NULs). */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The file's kind and media type from its bytes, when the name's extension
 * claims the same kind; null otherwise (unsupported or mismatched).
 */
export function sniffUpload(
  bytes: Uint8Array,
  filename: string
): SniffedUpload | null {
  const claimed = claimedKind(filename);
  if (!claimed) return null;
  switch (claimed) {
    case "image": {
      const mediaType = imageType(bytes);
      return mediaType ? { kind: "image", mediaType } : null;
    }
    case "pdf":
      return ascii(bytes, 0, 5) === "%PDF-"
        ? { kind: "pdf", mediaType: "application/pdf" }
        : null;
    case "docx":
      return officeKind(bytes) === "docx"
        ? { kind: "docx", mediaType: DOCX_MEDIA_TYPE }
        : null;
    case "xlsx":
      return officeKind(bytes) === "xlsx"
        ? { kind: "xlsx", mediaType: XLSX_MEDIA_TYPE }
        : null;
    case "text": {
      // A text name over bytes that are an image, PDF or ZIP is refused too.
      if (
        !isText(bytes) ||
        imageType(bytes) ||
        officeKind(bytes) ||
        ascii(bytes, 0, 5) === "%PDF-"
      ) {
        return null;
      }
      const ext = extensionOf(filename);
      return {
        kind: "text",
        mediaType: TEXT_MEDIA_TYPES[ext] ?? "text/plain",
      };
    }
  }
}

/** The kind of a stored file, from its media type. */
export function kindOfMediaType(mediaType: string): UploadKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === DOCX_MEDIA_TYPE) return "docx";
  if (mediaType === XLSX_MEDIA_TYPE) return "xlsx";
  return "text";
}

/**
 * The name shown in the chat and listed to the model: the basename, letters,
 * digits, `_ . - ` and spaces only (no line breaks or quotes to forge prompt
 * text with), at most 200 characters. The stored object key never uses it.
 */
export function uploadFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[^\p{L}\p{M}\p{N}_.\- ]+/gu, "_")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(clean || "file")
    .slice(0, 200)
    .join("");
}

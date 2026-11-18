import ExcelJS from "exceljs";

/**
 * Attachment conversion for the assistant: which formats v1 reads, and the
 * xlsx → CSV text that the model reads in place of a spreadsheet.
 */

export const MAX_ATTACHMENT_TEXT_BYTES = 200 * 1024;
/**
 * A PDF goes to the API base64-encoded (4/3 of its size) and the whole
 * request is capped at 32 MB, so 15 MiB leaves room for the conversation.
 */
export const MAX_PDF_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export type AttachmentFormat = "pdf" | "image" | "xlsx" | "unsupported";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const IMAGE_MIMES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Decide from Jira's metadata (mime type, then file extension). */
export function attachmentFormat(meta: {
  mimeType: string;
  filename: string;
}): AttachmentFormat {
  const mime = meta.mimeType.toLowerCase();
  const ext = meta.filename.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime === XLSX_MIME || ext === "xlsx") return "xlsx";
  if (IMAGE_MIMES.has(mime)) return "image";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  return "unsupported";
}

/** The image type the bytes actually are; providers reject a mismatch. */
export function sniffImage(bytes: Uint8Array): ImageMediaType | null {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return "image/gif";
  }
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

export function isPdf(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 5) === "%PDF-";
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * BA/PM mark changed cells with a yellow fill. Explicit ARGB colours count
 * when they are yellow-ish (high red and green, low blue: FFFF00, FFFF66,
 * FFD966 …); legacy palette index 13 is yellow. Theme colours are not
 * resolved (they depend on the workbook theme), so they are not flagged.
 */
export function isYellowFill(fill: ExcelJS.Fill | undefined): boolean {
  if (fill?.type !== "pattern" || fill.pattern === "none") return false;
  const color = fill.fgColor as { argb?: string; indexed?: number } | undefined;
  if (color?.indexed === 13) return true;
  const argb = color?.argb;
  if (!argb || !/^[0-9A-Fa-f]{8}$/.test(argb)) return false;
  const r = Number.parseInt(argb.slice(2, 4), 16);
  const g = Number.parseInt(argb.slice(4, 6), 16);
  const b = Number.parseInt(argb.slice(6, 8), 16);
  return r >= 0xf0 && g >= 0xd0 && b <= 0x99;
}

function noteText(note: ExcelJS.Cell["note"] | undefined): string | null {
  if (!note) return null;
  const text =
    typeof note === "string"
      ? note
      : (note.texts ?? []).map((t) => t.text).join("");
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.replace(/\s+/g, " ") : null;
}

function cellText(cell: ExcelJS.Cell): string {
  // A merged range shows its value once, at the master cell.
  if (cell.isMerged && cell.master !== cell) return "";
  let text: string;
  try {
    text = cell.text ?? "";
  } catch {
    text = String(cell.value ?? "");
  }
  if (isYellowFill(cell.fill)) text = `[highlight] ${text}`;
  const note = noteText(cell.note);
  if (note) text = `${text} [note: ${note}]`;
  return text;
}

/**
 * Every sheet as `## Sheet: <name>` followed by CSV rows, capped at
 * MAX_ATTACHMENT_TEXT_BYTES (UTF-8) with a truncation marker.
 */
export async function xlsxToText(
  bytes: Uint8Array,
  maxBytes = MAX_ATTACHMENT_TEXT_BYTES
): Promise<{ text: string; truncated: boolean }> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's typings predate the generic Buffer; the bytes are a plain view.
  await workbook.xlsx.load(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as never
  );

  const marker = `\n[truncated: attachment text exceeds ${Math.round(maxBytes / 1024)} KiB]`;
  const budget = maxBytes - Buffer.byteLength(marker);
  const parts: string[] = [];
  let used = 0;
  const push = (line: string): boolean => {
    const size = Buffer.byteLength(line) + 1;
    if (used + size > budget) return false;
    parts.push(line);
    used += size;
    return true;
  };

  for (const sheet of workbook.worksheets) {
    if (!push(`## Sheet: ${sheet.name}`)) return finish(true);
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const fields: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) {
        fields.push(csvField(cellText(row.getCell(c))));
      }
      while (fields.length > 0 && fields.at(-1) === "") fields.pop();
      if (!push(fields.join(","))) return finish(true);
    }
    if (!push("")) return finish(true);
  }
  return finish(false);

  function finish(truncated: boolean) {
    const text = parts.join("\n").trimEnd();
    return { text: truncated ? text + marker : text, truncated };
  }
}

import ExcelJS from "exceljs";
import { ZipFile } from "yazl";

// Small upload fixtures built in the test (neutral content): a one-page PDF,
// a Word document, a workbook, image headers and a plain ZIP.

/** A valid PDF with one page per text (ASCII only), in Helvetica. */
export function pdfBytes(text: string | string[]): Uint8Array {
  const pages = Array.isArray(text) ? text : [text];
  // 1 catalog, 2 pages, 3 font, then a page and its content per text.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((page, i) => {
    const stream = `BT /F1 12 Tf 20 100 Td (${page}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    );
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export async function zip(
  entries: Record<string, string | Uint8Array>
): Promise<Uint8Array> {
  const file = new ZipFile();
  for (const [path, content] of Object.entries(entries)) {
    file.addBuffer(Buffer.from(content), path);
  }
  file.end();
  const chunks: Buffer[] = [];
  for await (const chunk of file.outputStream) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/** A minimal Word document with one paragraph per line of `paragraphs`. */
export function docxBytes(paragraphs: string[]): Promise<Uint8Array> {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join("");
  return zip({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

/** A plain ZIP (no Office parts). */
export function zipBytes(): Promise<Uint8Array> {
  return zip({ "notes.txt": "hello" });
}

export async function xlsxBytes(rows: string[][]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Orders");
  for (const row of rows) sheet.addRow(row);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

/** PNG signature and IHDR start, padded to `size` bytes. */
export function pngBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  return bytes;
}

export function jpegBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

/**
 * The ZIP with every central-directory entry claiming `uncompressedSize`
 * (a crafted directory: small bytes, huge or false sizes).
 */
export function withClaimedSizes(
  bytes: Uint8Array,
  uncompressedSize: number
): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  let eocd = out.byteLength - 22;
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let at = view.getUint32(eocd + 16, true);
  for (let n = view.getUint16(eocd + 10, true); n > 0; n--) {
    view.setUint32(at + 24, uncompressedSize, true);
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  return out;
}

import { describe, expect, it } from "vitest";
import { extractUploadText } from "@/lib/assistant/file-text";
import {
  DOCX_MEDIA_TYPE,
  MAX_UPLOAD_TEXT_CHARS,
  sniffUpload,
  uploadFilename,
  XLSX_MEDIA_TYPE,
} from "@/lib/assistant/upload-types";
import {
  docxBytes,
  jpegBytes,
  pdfBytes,
  pngBytes,
  xlsxBytes,
  zipBytes,
} from "./support/upload-fixtures";

// What a question's upload is (by its bytes, agreeing with its name) and the
// text the model reads in its place.

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("sniffUpload", () => {
  it("takes an image by its bytes, with the type the bytes are", () => {
    expect(sniffUpload(pngBytes(), "shot.png")).toEqual({
      kind: "image",
      mediaType: "image/png",
    });
    // A JPEG saved as .png is still an image: the bytes name the type.
    expect(sniffUpload(jpegBytes(), "shot.png")).toEqual({
      kind: "image",
      mediaType: "image/jpeg",
    });
  });

  it("refuses a ZIP named .png, and a plain ZIP named .docx or .xlsx", async () => {
    const zip = await zipBytes();
    expect(sniffUpload(zip, "shot.png")).toBeNull();
    expect(sniffUpload(zip, "brief.docx")).toBeNull();
    expect(sniffUpload(zip, "orders.xlsx")).toBeNull();
  });

  it("tells a Word document from a workbook by its parts", async () => {
    const docx = await docxBytes(["Hello"]);
    const xlsx = await xlsxBytes([["a"]]);
    expect(sniffUpload(docx, "brief.docx")).toEqual({
      kind: "docx",
      mediaType: DOCX_MEDIA_TYPE,
    });
    expect(sniffUpload(xlsx, "orders.xlsx")).toEqual({
      kind: "xlsx",
      mediaType: XLSX_MEDIA_TYPE,
    });
    // Named as the other one: refused.
    expect(sniffUpload(docx, "brief.xlsx")).toBeNull();
    expect(sniffUpload(xlsx, "orders.docx")).toBeNull();
  });

  it("takes a PDF only under a .pdf name", () => {
    expect(sniffUpload(pdfBytes("Hi"), "report.pdf")).toEqual({
      kind: "pdf",
      mediaType: "application/pdf",
    });
    expect(sniffUpload(pdfBytes("Hi"), "report.txt")).toBeNull();
    expect(sniffUpload(utf8("plain words"), "report.pdf")).toBeNull();
  });

  it("takes UTF-8 text under a text or code name, never binary", () => {
    expect(sniffUpload(utf8("a,b\n1,2\n"), "data.csv")).toEqual({
      kind: "text",
      mediaType: "text/csv",
    });
    expect(sniffUpload(utf8("# Notes"), "README.md")?.mediaType).toBe(
      "text/markdown"
    );
    expect(sniffUpload(utf8('{"a":1}'), "a.json")?.mediaType).toBe(
      "application/json"
    );
    expect(sniffUpload(utf8("class A {}"), "A.java")?.mediaType).toBe(
      "text/plain"
    );
    expect(sniffUpload(new Uint8Array([0x61, 0, 0x62]), "a.txt")).toBeNull();
    expect(sniffUpload(new Uint8Array([0xc3, 0x28]), "a.txt")).toBeNull();
    expect(sniffUpload(pngBytes(), "a.txt")).toBeNull();
  });

  it("refuses names no question takes", () => {
    expect(sniffUpload(utf8("echo hi"), "run.exe")).toBeNull();
    expect(sniffUpload(utf8("<svg/>"), "logo.svg")).toBeNull();
    expect(sniffUpload(utf8("hi"), "noextension")).toBeNull();
  });
});

describe("uploadFilename", () => {
  it("keeps the basename's letters, never line breaks or quotes", () => {
    expect(uploadFilename("C:\\Users\\a\\Laporan Q3.pdf")).toBe(
      "Laporan Q3.pdf"
    );
    expect(uploadFilename('a"\n) ignore.txt')).toBe("a_ ignore.txt");
    expect(uploadFilename("报告.pdf")).toBe("报告.pdf");
    expect(uploadFilename("")).toBe("file");
    expect(Array.from(uploadFilename(`${"é".repeat(300)}.txt`))).toHaveLength(
      200
    );
  });
});

describe("extractUploadText", () => {
  it("reads a PDF's text", async () => {
    const { text, truncated } = await extractUploadText(
      pdfBytes("Acme invoice 42"),
      "pdf"
    );
    expect(text).toContain("Acme invoice 42");
    expect(truncated).toBe(false);
  });

  it("reads a Word document's paragraphs", async () => {
    const { text } = await extractUploadText(
      await docxBytes(["First line", "Second line"]),
      "docx"
    );
    expect(text).toContain("First line");
    expect(text).toContain("Second line");
  });

  it("reads a workbook as CSV per sheet", async () => {
    const { text } = await extractUploadText(
      await xlsxBytes([
        ["item", "qty"],
        ["widget", "3"],
      ]),
      "xlsx"
    );
    expect(text).toContain("## Sheet: Orders");
    expect(text).toContain("item,qty");
    expect(text).toContain("widget,3");
  });

  it("caps text at the limit, in characters, and says so", async () => {
    const long = "é".repeat(MAX_UPLOAD_TEXT_CHARS + 5);
    const { text, truncated } = await extractUploadText(utf8(long), "text");
    expect(truncated).toBe(true);
    expect(Array.from(text)).toHaveLength(MAX_UPLOAD_TEXT_CHARS);
    const short = await extractUploadText(utf8("hello"), "text");
    expect(short).toEqual({ text: "hello", truncated: false });
  });

  it("throws for bytes that are not the kind", async () => {
    await expect(extractUploadText(utf8("nope"), "pdf")).rejects.toThrow();
    await expect(extractUploadText(utf8("nope"), "docx")).rejects.toThrow();
  });
});

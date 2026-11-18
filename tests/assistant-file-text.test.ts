import { describe, expect, it, vi } from "vitest";
import {
  cap,
  ExtractionLimitError,
  extractUploadText,
  pdfToText,
} from "@/lib/assistant/file-text";
import {
  DOCX_MEDIA_TYPE,
  MAX_UPLOAD_TEXT_CHARS,
  sniffUpload,
  uploadFilename,
  XLSX_MEDIA_TYPE,
} from "@/lib/assistant/upload-types";
import { zipWithinBounds } from "@/lib/assistant/zip-bounds";
import {
  docxBytes,
  jpegBytes,
  pdfBytes,
  pngBytes,
  withClaimedSizes,
  xlsxBytes,
  zip,
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

  it("trims a long name before its extension", () => {
    const name = uploadFilename(`${"é".repeat(300)}.csv`);
    expect(Array.from(name)).toHaveLength(200);
    expect(name.endsWith("é.csv")).toBe(true);
    expect(sniffUpload(utf8("a,b"), name)?.kind).toBe("text");
    // No extension, or a dot that is no extension: a plain cut.
    expect(Array.from(uploadFilename("a".repeat(300)))).toHaveLength(200);
    expect(uploadFilename(`.${"a".repeat(300)}`)).toBe(`.${"a".repeat(199)}`);
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

  it("decodes only a bounded head of a large text file", async () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      const big = new Uint8Array(8 * 1024 * 1024).fill(0x61);
      const { text, truncated } = await extractUploadText(big, "text", 10);
      expect(text).toBe("a".repeat(10));
      expect(truncated).toBe(true);
      for (const [input] of decode.mock.calls) {
        expect((input as Uint8Array).byteLength).toBeLessThanOrEqual(40);
      }
      // A head that ends mid-character still yields whole characters.
      const emoji = utf8("😀".repeat(20));
      const capped = await extractUploadText(emoji, "text", 3);
      expect(capped).toEqual({ text: "😀😀😀", truncated: true });
      expect(await extractUploadText(utf8("😀😀"), "text", 2)).toEqual({
        text: "😀😀",
        truncated: false,
      });
    } finally {
      decode.mockRestore();
    }
  });

  it("caps a long string without copying it whole", () => {
    const from = vi.spyOn(Array, "from");
    try {
      const long = `${"😀".repeat(5)}${"x".repeat(1_000_000)}`;
      expect(cap(long, 6)).toEqual({ text: "😀😀😀😀😀x", truncated: true });
      expect(from).not.toHaveBeenCalled();
      expect(cap("ab", 2)).toEqual({ text: "ab", truncated: false });
    } finally {
      from.mockRestore();
    }
  });

  it("throws for bytes that are not the kind", async () => {
    await expect(extractUploadText(utf8("nope"), "pdf")).rejects.toThrow();
    await expect(extractUploadText(utf8("nope"), "docx")).rejects.toThrow();
  });
});

describe("PDF extraction bounds", () => {
  it("reads every page, in a worker", async () => {
    const { text, truncated } = await pdfToText(
      pdfBytes(["Page one", "Page two", "Page three"])
    );
    expect(text).toBe("Page one\nPage two\nPage three");
    expect(truncated).toBe(false);
  });

  it("stops at the page cap and at the character cap, saying so", async () => {
    const pages = pdfBytes(["Page one", "Page two", "Page three"]);
    expect(await pdfToText(pages, { maxPages: 2 })).toEqual({
      text: "Page one\nPage two",
      truncated: true,
    });
    expect(await pdfToText(pages, { maxChars: 12 })).toEqual({
      text: "Page one\nPag",
      truncated: true,
    });
  });

  it("kills a worker that does not answer in time", async () => {
    const started = Date.now();
    const error = await pdfToText(pdfBytes("Hi"), {
      timeoutMs: 200,
      workerUrl: new URL("./support/slow-pdf-worker.ts", import.meta.url),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtractionLimitError);
    expect((error as ExtractionLimitError).reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects bytes pdf.js cannot read", async () => {
    await expect(pdfToText(utf8("not a pdf"))).rejects.toThrow(
      "the PDF could not be read"
    );
  });
});

describe("ZIP bounds", () => {
  const MiB = 1024 * 1024;

  it("lets a real Word document and workbook through", async () => {
    expect(await zipWithinBounds(await docxBytes(["Hello"]))).toBe(true);
    expect(await zipWithinBounds(await xlsxBytes([["a", "b"]]))).toBe(true);
    // 2 MiB of zeros compresses far, but stays under the ratio floor.
    expect(
      await zipWithinBounds(await zip({ "a.bin": new Uint8Array(2 * MiB) }))
    ).toBe(true);
  });

  it("refuses a small ZIP whose directory claims a huge total", async () => {
    const small = await zip({ "a.xml": "<a/>", "b.xml": "<b/>" });
    expect(small.byteLength).toBeLessThan(1024);
    expect(await zipWithinBounds(withClaimedSizes(small, 60 * MiB))).toBe(
      false
    );
  });

  it("refuses an entry that claims an extreme ratio", async () => {
    const small = await zip({ "a.xml": "<a/>" });
    expect(await zipWithinBounds(withClaimedSizes(small, 20 * MiB))).toBe(
      false
    );
  });

  it("refuses a directory that claims less than the part inflates to", async () => {
    const zeros = await zip({ "a.bin": new Uint8Array(MiB) });
    expect(await zipWithinBounds(withClaimedSizes(zeros, 1000))).toBe(false);
  });

  it("refuses bytes without a readable directory", async () => {
    expect(await zipWithinBounds(utf8("PK not really"))).toBe(false);
  });

  it("extraction stops before inflating a crafted document", async () => {
    const bomb = withClaimedSizes(await docxBytes(["Hi"]), 60 * MiB);
    const error = await extractUploadText(bomb, "docx").catch((e) => e);
    expect(error).toBeInstanceOf(ExtractionLimitError);
    expect((error as ExtractionLimitError).reason).toBe("zip");
  });
});

import { getDocumentProxy } from "unpdf";

/**
 * A PDF's text page by page, stopping at `maxPages` pages or `maxChars`
 * characters (code points), whichever comes first; `truncated` when either
 * cut the text. Runs inside the PDF worker (pdf-text-worker.ts): relative
 * imports only, the worker is not resolved through the app's aliases.
 */
export async function pdfPagesText(
  bytes: Uint8Array,
  maxChars: number,
  maxPages: number
): Promise<{ text: string; truncated: boolean }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const parts: string[] = [];
    let chars = 0;
    const pages = Math.min(pdf.numPages, maxPages);
    for (let n = 1; n <= pages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
      }
      page.cleanup();
      if (!text.endsWith("\n")) text += "\n";
      const pageChars = Array.from(text);
      const room = maxChars - chars;
      if (pageChars.length > room) {
        parts.push(pageChars.slice(0, room).join(""));
        return { text: parts.join(""), truncated: true };
      }
      parts.push(text);
      chars += pageChars.length;
    }
    return {
      text: parts.join("").trimEnd(),
      truncated: pdf.numPages > maxPages,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

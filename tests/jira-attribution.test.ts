import { describe, expect, it } from "vitest";
import { adfToMarkdown, markdownToAdf } from "@/lib/jira/adf";
import { addAttribution, stripAttribution } from "@/lib/jira/attribution";

/**
 * The Jira connection authenticates as one person, so every comment Menara
 * pushes shows up in Jira under that account. The attribution line names the
 * real author on the way out and must vanish again on the way back in.
 */
describe("addAttribution", () => {
  it("prefixes the body with an italic author line", () => {
    expect(addAttribution("Fixed on staging.", "Jane Doe")).toBe(
      "*Written by Jane Doe via Menara*\n\nFixed on staging."
    );
  });
});

describe("stripAttribution", () => {
  it("removes the line addAttribution added", () => {
    const body = "Fixed on staging.\n\n- step one";
    expect(stripAttribution(addAttribution(body, "Rafi Pratama"))).toBe(
      body
    );
  });

  it("survives the Markdown -> ADF -> Markdown round trip through Jira", () => {
    const body = "Fixed on **staging**.";
    const roundTripped = adfToMarkdown(
      markdownToAdf(addAttribution(body, "Ajeng"))
    );
    expect(stripAttribution(roundTripped)).toBe(body);
  });

  it("removes the line older releases added", () => {
    // Comments pushed before the rename carry "via <Name> Panel".
    expect(
      stripAttribution("*Written by Jane Doe via Example Panel*\n\nFixed.")
    ).toBe("Fixed.");
  });

  it("leaves a comment written in Jira untouched", () => {
    expect(stripAttribution("Looks good to me.")).toBe("Looks good to me.");
  });

  it("only strips the line at the very start", () => {
    const body = "Quote:\n\n*Written by Someone via Menara*";
    expect(stripAttribution(body)).toBe(body);
  });
});

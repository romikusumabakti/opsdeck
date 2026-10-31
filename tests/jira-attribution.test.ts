import { describe, expect, it } from "vitest";
import { adfToMarkdown, markdownToAdf } from "@/lib/jira/adf";
import { addAttribution, stripAttribution } from "@/lib/jira/attribution";

/**
 * The Jira connection authenticates as one person, so every comment OpsDeck
 * pushes shows up in Jira under that account. The attribution line names the
 * real author on the way out and must vanish again on the way back in.
 */
describe("addAttribution", () => {
  it("prefixes the body with an italic author line", () => {
    expect(addAttribution("Fixed on staging.", "Randy Indra Rahim")).toBe(
      "*Written by Randy Indra Rahim via DSS Panel*\n\nFixed on staging."
    );
  });
});

describe("stripAttribution", () => {
  it("removes the line addAttribution added", () => {
    const body = "Fixed on staging.\n\n- step one";
    expect(stripAttribution(addAttribution(body, "Randy Indra Rahim"))).toBe(
      body
    );
  });

  it("survives the Markdown -> ADF -> Markdown round trip through Jira", () => {
    const body = "Fixed on **staging**.";
    const roundTripped = adfToMarkdown(
      markdownToAdf(addAttribution(body, "Anggi"))
    );
    expect(stripAttribution(roundTripped)).toBe(body);
  });

  it("leaves a comment written in Jira untouched", () => {
    expect(stripAttribution("Looks good to me.")).toBe("Looks good to me.");
  });

  it("only strips the line at the very start", () => {
    const body = "Quote:\n\n*Written by Someone via DSS Panel*";
    expect(stripAttribution(body)).toBe(body);
  });
});

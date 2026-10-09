import { describe, expect, it } from "bun:test";
import { resolveMentions } from "@/lib/mentions";

const ana = { id: "1", name: "Ana" };
const ana2 = { id: "2", name: "Ana (ana2)" };
const budi = { id: "3", name: "Budi Santoso" };
const all = [ana, ana2, budi];
const ids = (text: string) => resolveMentions(text, all).map((u) => u.id);

describe("resolveMentions", () => {
  it("does not notify a shorter name inside a longer mention", () => {
    expect(ids("thanks @Ana (ana2) for this")).toEqual(["2"]);
  });
  it("still matches the shorter name on its own", () => {
    expect(ids("thanks @Ana for this")).toEqual(["1"]);
  });
  it("matches a name at the end of the text", () => {
    expect(ids("cc @Budi Santoso")).toEqual(["3"]);
  });
  it("matches a name followed by punctuation", () => {
    expect(ids("@Budi Santoso, can you check?")).toEqual(["3"]);
    expect(ids("ask @Ana.")).toEqual(["1"]);
  });
  it("needs a word boundary after the name", () => {
    expect(ids("@Anabel is not Ana")).toEqual([]);
    expect(ids("@Ana2")).toEqual([]);
  });
  it("resolves two different mentions", () => {
    expect(ids("@Ana and @Budi Santoso").sort()).toEqual(["1", "3"]);
    expect(ids("@Ana (ana2) and @Ana").sort()).toEqual(["1", "2"]);
  });
  it("returns each user once", () => {
    expect(ids("@Ana @Ana")).toEqual(["1"]);
  });
  it("ignores text without mentions", () => {
    expect(ids("Ana and Budi Santoso")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  activeMention,
  applyMention,
  mentionMatches,
} from "@/web/components/assistant/mentions";

/** `|` marks the caret. */
const at = (marked: string) => {
  const caret = marked.indexOf("|");
  return activeMention(marked.replace("|", ""), caret);
};

describe("activeMention", () => {
  it.each([
    ["@np|", { start: 0, query: "np" }],
    ["@|", { start: 0, query: "" }],
    ["ask @np|", { start: 4, query: "np" }],
    ["(@x|", { start: 1, query: "x" }],
    ['"@x|', { start: 1, query: "x" }],
    ["line\n@x|", { start: 5, query: "x" }],
    ["@np| later", { start: 0, query: "np" }],
  ])("%j is a mention", (marked, expected) => {
    expect(at(marked)).toEqual(expected);
  });

  it.each([
    "a@b|",
    "user@example.invalid|",
    "@ x|",
    "@np |",
    "plain|",
    "|@np",
    "@a@b|",
  ])("%j is not a mention", (marked) => {
    expect(at(marked)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces @query with @label and a space, caret after it", () => {
    expect(
      applyMention(
        "ask @her now",
        { start: 4, query: "her" },
        "Heron Membership"
      )
    ).toEqual({ text: "ask @Heron Membership  now", caret: 22 });
    expect(
      applyMention("@her", { start: 0, query: "her" }, "Heron Membership")
    ).toEqual({ text: "@Heron Membership ", caret: 18 });
  });
});

describe("mentionMatches", () => {
  const projects = [
    {
      id: "p2",
      key: "GBIL",
      name: "Globex Billing",
      environments: [
        { id: "e3", name: "Staging", label: "Globex Billing · Staging" },
      ],
    },
    {
      id: "p1",
      key: "HMEM",
      name: "Heron Membership",
      environments: [
        { id: "e1", name: "Dev 1", label: "Heron Membership · Dev 1" },
        { id: "e2", name: "UAT", label: "Heron Membership · UAT" },
      ],
    },
  ];
  const labels = (query: string) =>
    mentionMatches(projects, query).map((m) => m.label);

  it("lists projects, then environments, matching name or key", () => {
    expect(labels("")).toEqual([
      "Globex Billing",
      "Heron Membership",
      "Globex Billing · Staging",
      "Heron Membership · Dev 1",
      "Heron Membership · UAT",
    ]);
    expect(labels("HER")).toEqual([
      "Heron Membership",
      "Heron Membership · Dev 1",
      "Heron Membership · UAT",
    ]);
    expect(labels("gbil")).toEqual([
      "Globex Billing",
      "Globex Billing · Staging",
    ]);
    expect(labels("uat")).toEqual(["Heron Membership · UAT"]);
    expect(labels("Transactional")).toEqual([]);
  });

  it("carries the context each match sets", () => {
    const [project, , environment] = mentionMatches(projects, "");
    expect(project?.context).toEqual({ kind: "project", projectId: "p2" });
    expect(environment?.context).toEqual({
      kind: "environment",
      environmentId: "e3",
    });
  });

  it("returns at most eight", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      key: `K${i}`,
      name: `Acme ${i}`,
      environments: [],
    }));
    expect(mentionMatches(many, "acme")).toHaveLength(8);
  });
});

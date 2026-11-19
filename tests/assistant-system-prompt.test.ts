import { describe, expect, it } from "vitest";
import {
  AUTO_NOTE_PROJECT_LIMIT,
  buildSourceNote,
  buildSystemPrompt,
  questionContextLabel,
} from "@/lib/assistant/system-prompt";

const project = (n: number, group: string | null = null) => ({
  key: `P${String(n).padStart(3, "0")}`,
  name: `Project ${n}`,
  group,
});

describe("buildSystemPrompt", () => {
  it("tells the model not to quote tool fields or raw JSON", () => {
    const text = buildSystemPrompt({
      userName: "Widya",
      preferredName: null,
      orgContext: null,
    });
    expect(text).toContain("Never quote tool field names");
  });

  it("names no project: the cached part depends only on the user and the organisation", () => {
    const text = buildSystemPrompt({
      userName: "Widya",
      preferredName: null,
      orgContext: null,
    });
    expect(text).not.toMatch(/^Project:/m);
    expect(text).toContain("You are talking with Widya.");
    // All three contexts are explained; which one applies is in the note.
    expect(text).toContain('"Context: automatic"');
    expect(text).toContain('"Source: project branches"');
    expect(text).toContain('"Environment: <name>"');
    expect(text).toContain("# Context of this question");
    expect(text).toContain('"(Context: …)"');
    expect(text).toContain("list_projects");
  });

  it("has a short Panel data section: read-only, and honest about unknown or unchecked status", () => {
    const text = buildSystemPrompt({
      userName: "Widya",
      preferredName: null,
      orgContext: null,
    });
    const section = text.slice(text.indexOf("# Panel data"));
    expect(text).toContain("# Panel data");
    for (const tool of [
      "list_environments",
      "get_environment_status",
      "list_deploys",
      "get_deploy",
      "list_builds",
      "search_panel_issues",
      "get_panel_issue",
      "list_people",
      "list_servers",
      "recent_activity",
    ]) {
      expect(section, tool).toContain(tool);
    }
    expect(section).toContain("read-only");
    expect(section).toContain('"unknown"');
    expect(section).toContain('"checked": false');
  });

  it("addresses the user by the preferred name, and still knows the full one", () => {
    const text = buildSystemPrompt({
      userName: "Dana Putri Lestari",
      preferredName: " Dana ",
      orgContext: null,
    });
    expect(text).toContain(
      "You are talking with Dana Putri Lestari. Address them as Dana."
    );
  });

  it("uses the full name when the preferred name is blank or the same", () => {
    for (const preferredName of ["  ", "Ana Maria"]) {
      const text = buildSystemPrompt({
        userName: "Ana Maria",
        preferredName,
        orgContext: null,
      });
      expect(text).toContain("You are talking with Ana Maria.\n");
      expect(text).not.toContain("Address them as");
    }
  });
});

describe("buildSourceNote", () => {
  it("lists the projects of an automatic question with their group", () => {
    const note = buildSourceNote({
      source: {
        kind: "auto",
        projects: [
          { key: "KST", name: "Kestrel", group: "Acme" },
          { key: "OSP", name: "Osprey", group: null },
        ],
      },
      sources: [],
    });
    expect(note).toMatch(/^# Context of this question\nContext: automatic\n/);
    expect(note).toContain("- KST — Kestrel (Acme)\n- OSP — Osprey");
    expect(note).toContain("project");
    expect(note).not.toContain("No source code is available");
    expect(note).not.toContain("more, call list_projects");
  });

  it(`caps the project list at ${AUTO_NOTE_PROJECT_LIMIT} lines`, () => {
    const projects = Array.from({ length: 53 }, (_, i) => project(i + 1));
    const note = buildSourceNote({
      source: { kind: "auto", projects },
      sources: [],
    });
    const lines = note.split("\n").filter((l) => /^- P\d{3} — /.test(l));
    expect(lines).toHaveLength(50);
    expect(note).toContain("- P050 — Project 50");
    expect(note).not.toContain("P051");
    expect(note).toContain("+3 more, call list_projects");
  });

  it("names the pinned project for project branches and for an environment", () => {
    const branches = buildSourceNote({
      source: { kind: "project", projectName: "Kestrel" },
      sources: [],
    });
    expect(branches).toMatch(
      /^# Context of this question\nProject: Kestrel\nSource: project branches\n/
    );
    const environment = buildSourceNote({
      source: {
        kind: "environment",
        environmentName: "Dev 1",
        projectName: "Kestrel",
      },
      sources: [],
    });
    expect(environment).toMatch(
      /^# Context of this question\nProject: Kestrel\nEnvironment: Dev 1\n/
    );
  });
});

describe("answer format and language", () => {
  const text = buildSystemPrompt({
    userName: "Widya",
    preferredName: null,
    orgContext: null,
  });

  it("answers in the question's language and drops the forced two-part structure", () => {
    expect(text).not.toContain("Yang dilakukan kode");
    expect(text).not.toContain("Write your answers in Indonesian");
    expect(text).toContain("language the user writes");
    expect(text).toContain("Lead with the direct answer");
  });

  it("keeps Drafts in Indonesian with explicit assumptions", () => {
    const drafts = text.slice(text.indexOf("# Drafts"));
    expect(drafts).toContain("in Indonesian");
    expect(drafts).toContain("assumption");
  });
});

describe("questionContextLabel", () => {
  it("labels each replayed question with its context", () => {
    expect(questionContextLabel({ kind: "auto" })).toBe("(Context: automatic)");
    expect(
      questionContextLabel({
        kind: "project",
        projectId: "p",
        projectName: "Kestrel",
      })
    ).toBe("(Context: project Kestrel)");
    expect(
      questionContextLabel({
        kind: "environment",
        environmentId: "e",
        environmentName: "Dev 1",
        projectId: "p",
        projectName: "Kestrel",
      })
    ).toBe("(Context: environment Kestrel / Dev 1)");
    expect(
      questionContextLabel({ kind: "gone", of: "project", label: "Kestrel" })
    ).toBe("(Context: Kestrel, deleted)");
    expect(
      questionContextLabel({ kind: "gone", of: "environment", label: "Old" })
    ).toBe("(Context: Old, deleted)");
  });
});

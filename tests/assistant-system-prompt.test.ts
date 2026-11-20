import { describe, expect, it } from "vitest";
import {
  AUTO_NOTE_PROJECT_LIMIT,
  aboutInstance,
  buildSourceNote,
  buildSystemPrompt,
  buildVolatileSystemNote,
  questionContextLabel,
  ROLE_LINES,
  type SystemPromptContext,
} from "@/lib/assistant/system-prompt";
import { MENARA_VERSION } from "@/lib/version";

const APP_NAME = "Menara";

/** A full prompt context: an engineer with every capability. */
const ctx = (
  overrides: Partial<SystemPromptContext> = {}
): SystemPromptContext => ({
  userName: "Widya",
  preferredName: null,
  orgContext: null,
  role: "engineer",
  title: null,
  timeZone: "Asia/Jakarta",
  lacking: [],
  appName: APP_NAME,
  ...overrides,
});

const project = (n: number, group: string | null = null) => ({
  key: `P${String(n).padStart(3, "0")}`,
  name: `Project ${n}`,
  group,
});

describe("buildSystemPrompt", () => {
  it("tells the model not to quote tool fields or raw JSON", () => {
    const text = buildSystemPrompt(ctx());
    expect(text).toContain("Never quote tool field names");
  });

  it("names no project: the cached part depends only on the user and the organisation", () => {
    const text = buildSystemPrompt(ctx());
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

  it("has a short Menara data section: read-only, and honest about unknown or unchecked status", () => {
    const text = buildSystemPrompt(ctx());
    const section = text.slice(text.indexOf("# Menara data"));
    expect(text).toContain("# Menara data");
    for (const tool of [
      "list_environments",
      "get_environment_status",
      "list_deploys",
      "get_deploy",
      "get_service_logs",
      "list_builds",
      "list_issues",
      "get_issue",
      "get_overview",
      "list_people",
      "list_servers",
      "recent_activity",
    ]) {
      expect(section, tool).toContain(tool);
    }
    expect(section).toContain("read-only");
    expect(section).toContain(
      "cannot deploy, restart, lock or change anything"
    );
    expect(section).toContain('"unknown"');
    expect(section).toContain('"checked": false');
  });

  it("has a Database section: when to query, masked and capped results, the enable hint", () => {
    const text = buildSystemPrompt(ctx());
    const start = text.indexOf("# Database");
    expect(start).toBeGreaterThan(text.indexOf("# Menara data"));
    const section = text.slice(start, text.indexOf("# Drafts"));
    expect(section).toContain("list_tables");
    expect(section).toContain("query_database");
    expect(section).toContain("read-only");
    expect(section).toMatch(/masked/);
    expect(section).toMatch(/100 rows/);
    expect(section).toContain("admin or infra");
    expect(section).toContain("Settings › Database");
    expect(section).toMatch(/never claim data you did not read/i);
    // Byte-stable per user: the same text for every role.
    expect(buildSystemPrompt(ctx())).toBe(text);
  });

  it("knows the preferred and the full name, but does not open answers with it", () => {
    const text = buildSystemPrompt(
      ctx({ userName: "Dana Putri Lestari", preferredName: " Dana " })
    );
    expect(text).toContain(
      "You are talking with Dana Putri Lestari, who prefers to be called Dana."
    );
    expect(text).not.toContain("Address them as");
    expect(text).toContain("Do not open your answers with their name");
  });

  it("uses the full name when the preferred name is blank or the same", () => {
    for (const preferredName of ["  ", "Ana Maria"]) {
      const text = buildSystemPrompt(
        ctx({ userName: "Ana Maria", preferredName })
      );
      expect(text).toContain("You are talking with Ana Maria.");
      expect(text).not.toContain("prefers to be called");
      expect(text).not.toContain("Address them as");
      expect(text).toContain("Do not open your answers with their name");
    }
  });

  it("says what this instance is: Menara, its name, open source, its upstream and version", () => {
    const text = buildSystemPrompt(ctx());
    const about = text.slice(text.indexOf("# About this instance"));
    expect(text).toContain("# About this instance");
    expect(about).toContain(
      `This Menara instance is called ${APP_NAME}; call it that when talking to the user.`
    );
    expect(about).toContain("Menara");
    expect(about).toContain("open source");
    expect(about).toContain("https://github.com/romikusumabakti/menara");
    expect(text).toContain(aboutInstance(MENARA_VERSION, APP_NAME));
  });

  it("names the instance from ctx.appName", () => {
    const name = ["Acme", "Ops"].join(" ");
    const text = buildSystemPrompt(ctx({ appName: name }));
    expect(text).toContain(
      `This Menara instance is called ${name}; call it that when talking to the user.`
    );
    expect(text).toContain(`You are the assistant built into ${name}`);
    expect(text).toContain(`tell the user where in ${name} to do it`);
  });

  it("is byte-identical for the same appName and changes only where the name appears", () => {
    const acme = ["Acme", "Ops"].join(" ");
    const beta = ["Beta", "Deck"].join(" ");
    const first = buildSystemPrompt(ctx({ appName: acme }));
    expect(buildSystemPrompt(ctx({ appName: acme }))).toBe(first);
    const second = buildSystemPrompt(ctx({ appName: beta }));
    expect(second).not.toBe(first);
    expect(second.replaceAll(beta, "<name>")).toBe(
      first.replaceAll(acme, "<name>")
    );
  });

  it("has a # User section with role, title and timezone", () => {
    const text = buildSystemPrompt(
      ctx({ role: "qa", title: "QA Lead", timeZone: "Asia/Makassar" })
    );
    const section = text.slice(text.indexOf("# User"));
    expect(text).toContain("# User");
    expect(section).toContain("qa");
    expect(section).toContain(ROLE_LINES.qa);
    expect(section).toContain("QA Lead");
    expect(section).toContain("Asia/Makassar");
    expect(section).toContain(
      "Do not offer what they cannot do. The role shapes tone and defaults only; it never grants access."
    );
    // No title line when none is set.
    expect(buildSystemPrompt(ctx())).not.toContain("Title:");
  });

  it("names what the user lacks", () => {
    const lacking = buildSystemPrompt(
      ctx({ lacking: ["database", "servers"] })
    );
    expect(lacking).toContain("no database tools");
    expect(lacking).toContain("no server access");
    expect(lacking).not.toContain("no activity log access");
    const all = buildSystemPrompt(ctx({ lacking: [] }));
    expect(all).not.toContain("no database tools");
    expect(all).not.toContain("no server access");
    expect(
      buildSystemPrompt(
        ctx({ role: "staff", lacking: ["projects", "activity"] })
      )
    ).toContain("no project data (code, environments, deploys, issues)");
  });

  it("tunes the guidance to the role group", () => {
    for (const role of ["qa", "ba", "pm", "staff", "observer"] as const) {
      const text = buildSystemPrompt(ctx({ role }));
      expect(text, role).toContain("behaviour before code");
      expect(text, role).not.toContain("show commands and queries");
    }
    for (const role of ["engineer", "infra", "admin"] as const) {
      const text = buildSystemPrompt(ctx({ role }));
      expect(text, role).toContain("show commands and queries");
      expect(text, role).not.toContain("behaviour before code");
    }
  });

  it("contains Default to action and the worked mappings", () => {
    const text = buildSystemPrompt(ctx());
    expect(text).toContain("# Default to action");
    expect(text).toContain("never answer such questions from memory");
    for (const needle of [
      "get_service_logs",
      "get_overview",
      "list_people",
      "updated_from",
      "created_from",
      "status: open, in_progress",
      "assignee: me",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("defaults a log check to the backend service", () => {
    const text = buildSystemPrompt(ctx());
    const mapping = text
      .split("\n")
      .find((line) => line.startsWith('- "check logs of some env"'));
    expect(mapping).toContain("get_service_logs");
    expect(mapping).toContain("backend service by default");
  });

  it("introduces itself for every role, on the code and the operations data", () => {
    const text = buildSystemPrompt(ctx());
    const intro = text.split("\n\n")[0] ?? "";
    expect(intro).toContain("code");
    expect(intro).toContain("operations data");
    expect(intro).not.toMatch(
      /Project managers, business analysts, QA testers and engineers/
    );
    expect(intro).not.toMatch(
      /BRD sections and Jira tickets match the real code/
    );
    expect(intro).toContain("every role");
    expect(intro.length).toBeLessThan(420);
  });

  it("never calls the product the Panel", () => {
    for (const role of ["qa", "engineer", "staff"] as const) {
      const text = buildSystemPrompt(
        ctx({ role, lacking: ["projects", "database", "servers", "activity"] })
      );
      expect(text.replaceAll(APP_NAME, "")).not.toMatch(/\bPanel\b/);
      expect(text).toContain(`This Menara instance is called ${APP_NAME}`);
    }
    const note = buildSourceNote(
      { source: { kind: "project", projectName: "Kestrel" }, sources: [] },
      "Asia/Jakarta"
    );
    expect(note.replaceAll(APP_NAME, "")).not.toMatch(/\bPanel\b/);
    expect(note).toContain("Menara data");
  });

  it("drops the brakes on tool use", () => {
    const text = buildSystemPrompt(ctx());
    expect(text).not.toContain("every tool result costs tokens");
    expect(text).not.toContain("stop exploring");
    expect(text).not.toContain("ask the user");
    expect(text).toContain("Never invent a key");
    // The narrow-search technique stays.
    expect(text).toContain("targeted search_code using a specific glob");
  });

  it("is byte-identical for the same user across contexts and calls", () => {
    const text = buildSystemPrompt(
      ctx({ role: "qa", timeZone: "Asia/Makassar" })
    );
    expect(
      buildSystemPrompt(ctx({ role: "qa", timeZone: "Asia/Makassar" }))
    ).toBe(text);
    const today = new Date().toISOString().slice(0, 10);
    expect(text).not.toContain(today);
    expect(text).not.toContain("Today's date");
  });

  it("converts shown times to the user's timezone", () => {
    expect(buildSystemPrompt(ctx({ timeZone: "Asia/Makassar" }))).toContain(
      "Times are UTC; convert them to the user's timezone (Asia/Makassar) when you show them."
    );
  });
});

describe("buildVolatileSystemNote", () => {
  it("the volatile note uses the user's timezone", () => {
    expect(
      buildVolatileSystemNote(new Date("2026-11-20T18:00:00Z"), "Asia/Jakarta")
    ).toBe("Today's date is 2026-11-21 (Asia/Jakarta).");
    expect(
      buildVolatileSystemNote(new Date("2026-11-20T18:00:00Z"), "UTC")
    ).toBe("Today's date is 2026-11-20 (UTC).");
  });
});

describe("aboutInstance", () => {
  it("names a release version, or a development build", () => {
    expect(aboutInstance("1.4.0", APP_NAME)).toContain("version 1.4.0");
    expect(aboutInstance("1.5.0-beta.2", APP_NAME)).toContain(
      "version 1.5.0-beta.2"
    );
    const dev = aboutInstance("0.0.0-dev", APP_NAME);
    expect(dev).toContain("development build");
    expect(dev).not.toContain("0.0.0-dev");
  });
});

describe("buildSourceNote", () => {
  it("lists the projects of an automatic question with their group", () => {
    const note = buildSourceNote(
      {
        source: {
          kind: "auto",
          projects: [
            { key: "KST", name: "Kestrel", group: "Acme" },
            { key: "OSP", name: "Osprey", group: null },
          ],
        },
        sources: [],
      },
      "Asia/Jakarta"
    );
    expect(note).toMatch(/^# Context of this question\nContext: automatic\n/);
    expect(note).toContain("- KST — Kestrel (Acme)\n- OSP — Osprey");
    expect(note).toContain("project");
    expect(note).not.toContain("No source code is available");
    expect(note).not.toContain("more, call list_projects");
  });

  it(`caps the project list at ${AUTO_NOTE_PROJECT_LIMIT} lines`, () => {
    const projects = Array.from({ length: 53 }, (_, i) => project(i + 1));
    const note = buildSourceNote(
      {
        source: { kind: "auto", projects },
        sources: [],
      },
      "Asia/Jakarta"
    );
    const lines = note.split("\n").filter((l) => /^- P\d{3} — /.test(l));
    expect(lines).toHaveLength(50);
    expect(note).toContain("- P050 — Project 50");
    expect(note).not.toContain("P051");
    expect(note).toContain("+3 more, call list_projects");
  });

  it("names the pinned project for project branches and for an environment", () => {
    const branches = buildSourceNote(
      {
        source: { kind: "project", projectName: "Kestrel" },
        sources: [],
      },
      "Asia/Jakarta"
    );
    expect(branches).toMatch(
      /^# Context of this question\nProject: Kestrel\nSource: project branches\n/
    );
    const environment = buildSourceNote(
      {
        source: {
          kind: "environment",
          environmentName: "Dev 1",
          projectName: "Kestrel",
        },
        sources: [],
      },
      "Asia/Jakarta"
    );
    expect(environment).toMatch(
      /^# Context of this question\nProject: Kestrel\nEnvironment: Dev 1\n/
    );
  });
});

describe("answer format and language", () => {
  const text = buildSystemPrompt(ctx());

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

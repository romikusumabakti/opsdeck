import { describe, expect, it, vi } from "vitest";
import type { AssistantViewer } from "@/lib/assistant/viewer";

const calls = vi.hoisted(() => [] as { fn: string; args: unknown[] }[]);
const record =
  (fn: string) =>
  async (...args: unknown[]) => {
    calls.push({ fn, args });
    return { ok: true, data: null, meta: {} };
  };

vi.mock("@/lib/assistant/tools/code", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/tools/code")>()),
  listFiles: vi.fn(record("listFiles")),
  searchCode: vi.fn(record("searchCode")),
  readFile: vi.fn(async () => {
    throw new Error("disk exploded at /var/lib/menara/secret");
  }),
}));
vi.mock("@/lib/assistant/tools/context", () => ({
  getIssueTool: vi.fn(record("getIssueTool")),
  readAttachmentTool: vi.fn(record("readAttachmentTool")),
  searchKnowledgeTool: vi.fn(record("searchKnowledgeTool")),
  readKnowledgeTool: vi.fn(record("readKnowledgeTool")),
}));

const { TOOL_DEFS, executeTool } = await import("@/lib/assistant/tool-defs");

const viewer: AssistantViewer = {
  userId: "u",
  orgRole: "qa",
  projectIds: [],
  canManageKnowledge: false,
};
const ticked = [{ issueKey: "KST-1", attachmentId: "900" }];
const ctx = { snaps: [], viewer, attachments: ticked };

type JsonSchema = {
  type?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: unknown;
};

describe("TOOL_DEFS", () => {
  it("defines the seven tools", () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual([
      "list_files",
      "search_code",
      "read_file",
      "get_issue",
      "read_attachment",
      "search_knowledge",
      "read_knowledge",
    ]);
  });

  it("states the 15 MiB PDF cap of read_attachment", () => {
    const tool = TOOL_DEFS.find((t) => t.name === "read_attachment");
    expect(tool?.description).toContain("PDF (≤15 MiB)");
  });

  it("is strict: closed objects with every property required", () => {
    for (const tool of TOOL_DEFS) {
      expect(tool.strict, tool.name).toBe(true);
      expect(tool.description?.length, tool.name).toBeGreaterThan(20);
      const schema = tool.input_schema as JsonSchema;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties, tool.name).toBe(false);
      expect(schema.required).toEqual(Object.keys(schema.properties ?? {}));
    }
  });
});

describe("executeTool", () => {
  it("rejects an unknown tool", async () => {
    const result = await executeTool("bash", {}, ctx);
    expect(result).toEqual({
      ok: false,
      error: "unknown tool: bash",
      meta: {},
    });
    const proto = await executeTool("toString", {}, ctx);
    expect(proto.ok).toBe(false);
  });

  it("rejects invalid input without running the tool", async () => {
    calls.length = 0;
    const result = await executeTool("list_files", { glob: 1 }, ctx);
    expect(result.ok).toBe(false);
    const extra = await executeTool("get_issue", { key: "A-1", x: 1 }, ctx);
    expect(extra.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("maps snake_case and null inputs onto the tool functions", async () => {
    calls.length = 0;
    await executeTool(
      "search_code",
      { pattern: "iuran", regex: null, glob: "**/*.java", ignore_case: true },
      ctx
    );
    await executeTool(
      "read_attachment",
      { issue_key: "KST-1", attachment_id: "900" },
      ctx
    );
    expect(calls).toEqual([
      {
        fn: "searchCode",
        args: [
          [],
          {
            pattern: "iuran",
            regex: undefined,
            glob: "**/*.java",
            ignoreCase: true,
          },
        ],
      },
      {
        fn: "readAttachmentTool",
        args: [viewer, ticked, { issueKey: "KST-1", attachmentId: "900" }],
      },
    ]);
  });

  it("turns an unexpected failure into a generic tool error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await executeTool(
      "read_file",
      { path: "a/b", start_line: null, end_line: null },
      ctx
    );
    expect(result).toEqual({
      ok: false,
      error: "read_file failed unexpectedly",
      meta: {},
    });
    spy.mockRestore();
  });
});

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

const { buildTools, executeTool, toolModelOutput, TOOL_NAMES } = await import(
  "@/lib/assistant/tool-defs"
);
const { asSchema } = await import("ai");

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
  description?: string;
};

const noRecord = async () => {};
const execOptions = { toolCallId: "call-1", messages: [] };

/** Runs a built tool's execute as the SDK would. */
const run = (
  tools: ReturnType<typeof buildTools>,
  name: string,
  input: Record<string, unknown>
) => {
  const execute = tools[name]?.execute as unknown as
    | ((
        input: Record<string, unknown>,
        options: typeof execOptions
      ) => Promise<unknown>)
    | undefined;
  if (!execute) throw new Error(`no tool ${name}`);
  return execute(input, execOptions);
};

describe("buildTools", () => {
  it("defines the seven tools in order", () => {
    const names = [
      "list_files",
      "search_code",
      "read_file",
      "get_issue",
      "read_attachment",
      "search_knowledge",
      "read_knowledge",
    ];
    expect(Object.keys(buildTools(ctx, noRecord))).toEqual(names);
    expect(TOOL_NAMES).toEqual(names);
  });

  it("states the 15 MiB PDF cap of read_attachment", () => {
    const tool = buildTools(ctx, noRecord).read_attachment;
    expect(tool?.description).toContain("PDF (≤15 MiB)");
  });

  it("is strict: closed objects with every property required and described", async () => {
    for (const [name, tool] of Object.entries(buildTools(ctx, noRecord))) {
      expect((tool as { strict?: boolean }).strict, name).toBe(true);
      expect(String(tool.description).length, name).toBeGreaterThan(20);
      const schema = (await asSchema(tool.inputSchema)
        .jsonSchema) as JsonSchema;
      expect(schema.type, name).toBe("object");
      expect(schema.additionalProperties, name).toBe(false);
      expect(schema.required, name).toEqual(
        Object.keys(schema.properties ?? {})
      );
      for (const [prop, def] of Object.entries(schema.properties ?? {})) {
        expect(def.description?.length, `${name}.${prop}`).toBeGreaterThan(5);
      }
    }
  });

  it("marks only the last tool with the given provider options", () => {
    const cache = { anthropic: { cacheControl: { type: "ephemeral" } } };
    const tools = Object.values(
      buildTools(ctx, noRecord, { lastToolProviderOptions: cache })
    );
    expect(tools.at(-1)?.providerOptions).toEqual(cache);
    expect(tools.slice(0, -1).some((t) => t.providerOptions)).toBe(false);
    expect(
      Object.values(buildTools(ctx, noRecord)).some((t) => t.providerOptions)
    ).toBe(false);
  });

  it("runs the call through executeTool and records it", async () => {
    calls.length = 0;
    const recorded: unknown[] = [];
    const tools = buildTools(ctx, async (call) => {
      recorded.push(call);
    });
    const input = { glob: "backend/**/*.java" };
    const result = await run(tools, "list_files", input);
    expect(result).toEqual({ ok: true, data: null, meta: {} });
    expect(calls).toEqual([
      { fn: "listFiles", args: [[], "backend/**/*.java"] },
    ]);
    expect(recorded).toEqual([{ tool: "list_files", input, resultMeta: {} }]);
  });

  it("uses an injected executor", async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      data: { hit: 1 },
      meta: { paths: ["a"] },
    }));
    const recorded: unknown[] = [];
    const tools = buildTools(
      ctx,
      async (call) => {
        recorded.push(call);
      },
      { execute }
    );
    await run(tools, "get_issue", { key: "KST-1" });
    expect(execute).toHaveBeenCalledWith("get_issue", { key: "KST-1" }, ctx);
    expect(recorded).toEqual([
      {
        tool: "get_issue",
        input: { key: "KST-1" },
        resultMeta: { paths: ["a"] },
      },
    ]);
  });
});

describe("toolModelOutput", () => {
  it("turns attachments into file and text parts and failures into error text", () => {
    expect(
      toolModelOutput("read_attachment", {
        ok: true,
        data: {
          kind: "document",
          mediaType: "application/pdf",
          base64: "UERG",
        },
        meta: {},
      })
    ).toEqual({
      type: "content",
      value: [
        {
          type: "file",
          data: { type: "data", data: "UERG" },
          mediaType: "application/pdf",
        },
      ],
    });
    expect(
      toolModelOutput("read_attachment", {
        ok: true,
        data: { kind: "image", mediaType: "image/png", base64: "iVBO" },
        meta: {},
      })
    ).toEqual({
      type: "content",
      value: [
        {
          type: "file",
          data: { type: "data", data: "iVBO" },
          mediaType: "image/png",
        },
      ],
    });
    expect(
      toolModelOutput("read_attachment", {
        ok: true,
        data: { kind: "text", text: "a,b" },
        meta: {},
      })
    ).toEqual({ type: "content", value: [{ type: "text", text: "a,b" }] });
    expect(
      toolModelOutput("get_issue", { ok: false, error: "not found", meta: {} })
    ).toEqual({ type: "error-text", value: "not found" });
  });

  it("sends other tools' data as JSON text even when it has a kind field", () => {
    const data = { kind: "text", text: "not an attachment" };
    expect(
      toolModelOutput("read_knowledge", { ok: true, data, meta: {} })
    ).toEqual({ type: "text", value: JSON.stringify(data) });
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

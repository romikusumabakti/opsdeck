import { beforeEach, describe, expect, it, vi } from "vitest";
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
  scope: {
    userId: "u",
    orgRole: "qa",
    projectRoles: {},
    seesAllProjects: false,
  },
};
const ticked = [{ issueKey: "KST-1", attachmentId: "900" }];
const ctx = { mode: "pinned" as const, snaps: [], viewer, attachments: ticked };

const KST_SNAPS = [
  { componentKey: "backend", dir: "/cache/kst", commitSha: "abc123" },
];
const snapshotsFor = vi.fn(async (key: string) =>
  key === "KST" ? KST_SNAPS : ({ error: "unknown_project" } as const)
);
const listProjects = vi.fn(async () => [
  {
    key: "KST",
    name: "Kestrel",
    description: "Membership",
    components: ["backend"],
  },
]);
const autoCtx = {
  mode: "auto" as const,
  viewer,
  attachments: ticked,
  snapshotsFor,
  listProjects,
};
const CODE_TOOLS = ["list_files", "search_code", "read_file"] as const;

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

/** Every tool's description and JSON input schema, as sent to the model. */
const wireOf = async (tools: ReturnType<typeof buildTools>) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(tools).map(async ([name, t]) => [
        name,
        {
          description: t.description,
          schema: await asSchema(t.inputSchema).jsonSchema,
        },
      ])
    )
  );

describe("buildTools", () => {
  it("sends the Stage 2 tool set and schemas in a pinned context", async () => {
    expect(await wireOf(buildTools(ctx, noRecord))).toMatchSnapshot();
  });

  it("adds list_projects and a required project key to the code tools in automatic context", async () => {
    const pinned = await wireOf(buildTools(ctx, noRecord));
    const auto = await wireOf(buildTools(autoCtx, noRecord));
    expect(Object.keys(auto)).toEqual([
      "list_projects",
      ...Object.keys(pinned),
    ]);
    // Explicit: strict tools need the empty required list.
    expect(auto.list_projects?.schema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    for (const name of CODE_TOOLS) {
      const schema = auto[name]?.schema as JsonSchema;
      const base = pinned[name]?.schema as JsonSchema;
      expect(schema.properties?.project, name).toEqual({
        type: "string",
        description: expect.stringContaining("list_projects"),
      });
      expect(schema.required, name).toEqual([
        "project",
        ...(base.required ?? []),
      ]);
      expect(String(auto[name]?.description), name).toContain("project");
    }
    // Issue and knowledge tools are the same in both modes.
    for (const name of [
      "get_issue",
      "read_attachment",
      "search_knowledge",
      "read_knowledge",
    ]) {
      expect(auto[name], name).toEqual(pinned[name]);
    }
  });

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

  it("describes the code tools for either source, branches or an environment", () => {
    const tools = buildTools(ctx, noRecord);
    for (const name of ["list_files", "search_code", "read_file"] as const) {
      const description = String(tools[name]?.description);
      expect(description, name).toContain("selected source snapshot");
      expect(description, name).not.toContain("the environment's");
    }
    expect(String(tools.list_files?.description)).toContain("project branches");
  });

  it("sends no numeric or length bounds in tool schemas (strict tools reject them)", async () => {
    const { asSchema } = await import("ai");
    const BOUNDS = [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minLength",
      "maxLength",
    ];
    const found: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (BOUNDS.includes(key)) found.push(`${path}.${key}`);
        walk(value, `${path}.${key}`);
      }
    };
    for (const context of [ctx, autoCtx]) {
      for (const [name, tool] of Object.entries(
        buildTools(context, noRecord)
      )) {
        walk(
          await asSchema(tool.inputSchema).jsonSchema,
          `${context.mode}.${name}`
        );
      }
    }
    expect(found).toEqual([]);
  });

  it("is strict: closed objects with every property required and described", async () => {
    const all = [
      ...Object.entries(buildTools(ctx, noRecord)),
      ...Object.entries(buildTools(autoCtx, noRecord)),
    ];
    for (const [name, tool] of all) {
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
    const cache = { acme: { cacheControl: { type: "ephemeral" } } };
    for (const context of [ctx, autoCtx]) {
      const tools = Object.values(
        buildTools(context, noRecord, { lastToolProviderOptions: cache })
      );
      expect(tools.at(-1)?.providerOptions).toEqual(cache);
      expect(tools.slice(0, -1).some((t) => t.providerOptions)).toBe(false);
    }
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

describe("executeTool in automatic context", () => {
  beforeEach(() => {
    calls.length = 0;
    snapshotsFor.mockClear();
    listProjects.mockClear();
  });

  it("lists the visible projects", async () => {
    const result = await executeTool("list_projects", {}, autoCtx);
    expect(result).toEqual({
      ok: true,
      data: {
        projects: [
          {
            key: "KST",
            name: "Kestrel",
            description: "Membership",
            components: ["backend"],
          },
        ],
      },
      meta: { projectKeys: ["KST"] },
    });
  });

  it("reads the chosen project's snapshots and records the project", async () => {
    const result = await executeTool(
      "list_files",
      { project: "KST", glob: "backend/**" },
      autoCtx
    );
    expect(snapshotsFor).toHaveBeenCalledExactlyOnceWith("KST");
    expect(calls).toEqual([
      { fn: "listFiles", args: [KST_SNAPS, "backend/**"] },
    ]);
    expect(result).toEqual({
      ok: true,
      data: null,
      meta: { project: "KST" },
    });
  });

  it("normalises the project key before looking it up", async () => {
    const result = await executeTool(
      "list_files",
      { project: " kst ", glob: "backend/**" },
      autoCtx
    );
    expect(snapshotsFor).toHaveBeenCalledExactlyOnceWith("KST");
    expect(result.meta).toEqual({ project: "KST" });
  });

  it("refuses a project the user cannot see without reading anything", async () => {
    for (const [name, input] of [
      ["list_files", { project: "SECRET", glob: "**" }],
      [
        "search_code",
        {
          project: "SECRET",
          pattern: "x",
          regex: null,
          glob: null,
          ignore_case: null,
        },
      ],
      [
        "read_file",
        { project: "SECRET", path: "a/b", start_line: null, end_line: null },
      ],
    ] as const) {
      const result = await executeTool(name, input, autoCtx);
      expect(result, name).toEqual({
        ok: false,
        error: "Unknown project SECRET. Call list_projects.",
        meta: { project: "SECRET" },
      });
    }
    expect(calls).toEqual([]);
  });

  it("says so when no code of the project can be read", async () => {
    const empty = { ...autoCtx, snapshotsFor: async () => [] };
    const result = await executeTool(
      "list_files",
      { project: "KST", glob: "**" },
      empty
    );
    expect(result).toEqual({
      ok: false,
      error: "No source code of project KST can be read.",
      meta: { project: "KST" },
    });
    expect(calls).toEqual([]);
  });

  it("requires the project argument on code tools", async () => {
    const result = await executeTool("list_files", { glob: "**" }, autoCtx);
    expect(result.ok).toBe(false);
    expect(snapshotsFor).not.toHaveBeenCalled();
  });
});

describe("executeTool in a pinned context", () => {
  it("offers no list_projects and refuses a project argument", async () => {
    calls.length = 0;
    expect(await executeTool("list_projects", {}, ctx)).toEqual({
      ok: false,
      error: "unknown tool: list_projects",
      meta: {},
    });
    const result = await executeTool(
      "list_files",
      { project: "KST", glob: "**" },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

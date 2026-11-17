import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { AttachmentRef } from "./attachment-refs";
import type { ProviderOptions } from "./providers";
import {
  listFiles,
  MAX_LIST_PATHS,
  MAX_READ_BYTES,
  MAX_READ_LINES,
  MAX_SEARCH_BYTES,
  MAX_SEARCH_MATCHES,
  MAX_WITHHELD_PATHS,
  readFile,
  type SnapshotRef,
  searchCode,
  type ToolResult,
} from "./tools/code";
import {
  type AttachmentContent,
  getIssueTool,
  readAttachmentTool,
  readKnowledgeTool,
  searchKnowledgeTool,
} from "./tools/context";
import type { AssistantViewer } from "./viewer";

/**
 * The tools the model may call, as strict AI SDK tools, and the dispatcher
 * that validates each call's input and runs it for one viewer. Strict mode:
 * every object is closed and lists every property as required; optional
 * inputs are nullable instead.
 */

const str = (description: string) => z.string().describe(description);
const nullable = <T extends z.ZodType>(type: T, description: string) =>
  type.nullable().describe(description);

/**
 * What the model sees in a pinned context (a project's branches or an
 * environment): names, descriptions and input schemas. Unchanged since
 * Stage 2 (tests/__snapshots__/assistant-tool-defs.test.ts.snap).
 */
const DEFINITIONS = {
  list_files: {
    description: `List file paths in the selected source snapshot (the project branches or an environment's running commits), matching a glob (e.g. "backend/src/**/*.java"). Paths are prefixed with the component key. At most ${MAX_LIST_PATHS} paths, so use a specific glob. Files that may hold secrets are withheld: counted in "withheld" and named (up to ${MAX_WITHHELD_PATHS}) in "withheldPaths", never readable.`,
    inputSchema: z.strictObject({
      glob: str(
        'Glob over component-prefixed paths, as narrow as possible (e.g. "backend/src/**/*Iuran*.java"); avoid "**/*".'
      ),
    }),
  },
  search_code: {
    description: `Search file contents of the selected source snapshot. Returns at most ${MAX_SEARCH_MATCHES} matches (${MAX_SEARCH_BYTES / 1024} KiB in total) with path, line number and ±2 lines of context; narrow it with a specific glob. Literal match unless regex is true. Files that may hold secrets are never searched; "withheld" counts them.`,
    inputSchema: z.strictObject({
      pattern: str("Text (or regular expression when regex is true) to find."),
      regex: nullable(
        z.boolean(),
        "Treat pattern as a regular expression. Default false."
      ),
      glob: nullable(z.string(), "Only search paths matching this glob."),
      ignore_case: nullable(
        z.boolean(),
        "Case-insensitive match. Default false."
      ),
    }),
  },
  read_file: {
    description: `Read a file from the selected source snapshot by its component-prefixed path, optionally a 1-based line range. At most ${MAX_READ_LINES} lines or ${MAX_READ_BYTES / 1024} KiB per call; read only the range you need and page with start_line for more. Files that may hold secrets are withheld and return an error saying so.`,
    inputSchema: z.strictObject({
      path: str(
        "Component-prefixed path as returned by list_files/search_code."
      ),
      // Plain numbers: z.int() emits safe-integer minimum/maximum, which
      // strict tool schemas reject. INPUTS checks the whole-number rule.
      start_line: nullable(
        z.number(),
        "First line to read (1-based whole number). Default 1."
      ),
      end_line: nullable(
        z.number(),
        "Last line to read, inclusive (whole number)."
      ),
    }),
  },
  get_issue: {
    description:
      "Get a Jira issue mirrored in the Panel for a project the user can see: title, status, type, description, comments (latest 100) and the attachment list (names, types, sizes only). Unknown or invisible keys return not found.",
    inputSchema: z.strictObject({
      key: str('Jira issue key, e.g. "KST-123".'),
    }),
  },
  read_attachment: {
    description:
      "Read the content of one Jira attachment the user ticked for this message (other attachments are refused). PDF (≤15 MiB) and PNG/JPEG/GIF/WebP images (≤5 MiB) are returned as-is; XLSX is converted to CSV text per sheet (≤200 KiB) with yellow-highlighted cells marked [highlight] and cell notes as [note: …]. Other formats are not supported.",
    inputSchema: z.strictObject({
      issue_key: str(
        "Key of the issue the attachment belongs to, as listed with the ticked attachments."
      ),
      attachment_id: str(
        "Attachment id, as listed with the ticked attachments (or in get_issue's attachment list)."
      ),
    }),
  },
  search_knowledge: {
    description:
      "Full-text search of the Panel knowledge base (documents the user can read). Returns up to 20 hits with slug, title and a snippet.",
    inputSchema: z.strictObject({
      query: str("Search terms; supports quoted phrases, OR and -exclusion."),
    }),
  },
  read_knowledge: {
    description:
      "Read a knowledge-base document by slug as markdown (at most 64 KiB). Drafts the user cannot see return not found.",
    inputSchema: z.strictObject({
      slug: str("Document slug from search_knowledge."),
    }),
  },
} as const;

const project = str(
  'Key of the project to read, as listed in the question\'s context note or by list_projects (e.g. "KST").'
);

/**
 * The automatic context: list_projects first, and the code tools take the
 * project to read. The issue and knowledge tools are the pinned ones.
 */
const AUTO_DEFINITIONS = {
  list_projects: {
    description:
      "List the projects the user can see: key, name, short description and component keys. Use it when the context note does not make clear which project a question is about; the code tools take one of these keys as project.",
    inputSchema: z.strictObject({}),
  },
  list_files: {
    description: `List file paths in one project's branches (the project given by key), matching a glob (e.g. "backend/src/**/*.java"). Paths are prefixed with the component key and are relative to that project. At most ${MAX_LIST_PATHS} paths, so use a specific glob. Files that may hold secrets are withheld: counted in "withheld" and named (up to ${MAX_WITHHELD_PATHS}) in "withheldPaths", never readable.`,
    inputSchema: z.strictObject({
      project,
      ...DEFINITIONS.list_files.inputSchema.shape,
    }),
  },
  search_code: {
    description: `Search file contents of one project's branches (the project given by key). Returns at most ${MAX_SEARCH_MATCHES} matches (${MAX_SEARCH_BYTES / 1024} KiB in total) with path, line number and ±2 lines of context; narrow it with a specific glob. Literal match unless regex is true. Files that may hold secrets are never searched; "withheld" counts them.`,
    inputSchema: z.strictObject({
      project,
      ...DEFINITIONS.search_code.inputSchema.shape,
    }),
  },
  read_file: {
    description: `Read a file of one project's branches (the project given by key) by its component-prefixed path, optionally a 1-based line range. At most ${MAX_READ_LINES} lines or ${MAX_READ_BYTES / 1024} KiB per call; read only the range you need and page with start_line for more. Files that may hold secrets are withheld and return an error saying so.`,
    inputSchema: z.strictObject({
      project,
      ...DEFINITIONS.read_file.inputSchema.shape,
    }),
  },
  get_issue: DEFINITIONS.get_issue,
  read_attachment: DEFINITIONS.read_attachment,
  search_knowledge: DEFINITIONS.search_knowledge,
  read_knowledge: DEFINITIONS.read_knowledge,
} as const;

/** The tools of a pinned context, in order. */
export const TOOL_NAMES = Object.keys(DEFINITIONS) as ToolName[];

/** One executed tool call, as written to the audit trail. */
export type RecordedToolCall = {
  tool: ToolName;
  input: Record<string, unknown>;
  resultMeta: Record<string, unknown>;
};

export type ToolExecutor = (
  name: string,
  input: unknown,
  ctx: ToolContext
) => Promise<ToolResult<unknown>>;

/** A read_attachment result as parts the model reads natively. */
function attachmentOutput(data: AttachmentContent): ToolResultOutput {
  if (data.kind === "text") {
    return { type: "content", value: [{ type: "text", text: data.text }] };
  }
  return {
    type: "content",
    value: [
      {
        type: "file",
        data: { type: "data", data: data.base64 },
        mediaType: data.mediaType,
      },
    ],
  };
}

/**
 * One tool's result as the model sees it: read_attachment data
 * (AttachmentContent) becomes file/text parts, any other tool's data JSON
 * text, a failure an error result.
 */
export function toolModelOutput(
  name: string,
  result: ToolResult<unknown>
): ToolResultOutput {
  if (!result.ok) return { type: "error-text", value: result.error };
  if (name === "read_attachment") {
    return attachmentOutput(result.data as AttachmentContent);
  }
  return { type: "text", value: JSON.stringify(result.data) };
}

/**
 * The tools for one turn. Each call runs through `execute` (executeTool by
 * default) and is then passed to `record` for the audit trail; a failing
 * `record` fails the call. `lastToolProviderOptions` go on the last tool only
 * (a prompt-cache breakpoint after the tool definitions).
 */
export function buildTools(
  ctx: ToolContext,
  record: (call: RecordedToolCall) => Promise<void>,
  options: {
    execute?: ToolExecutor;
    lastToolProviderOptions?: ProviderOptions;
  } = {}
): ToolSet {
  const execute = options.execute ?? executeTool;
  const entries = Object.entries(
    ctx.mode === "auto" ? AUTO_DEFINITIONS : DEFINITIONS
  ) as Array<[ToolName, { description: string; inputSchema: z.ZodType }]>;
  return Object.fromEntries(
    entries.map(([name, definition], index) => [
      name,
      tool({
        description: definition.description,
        inputSchema: definition.inputSchema as z.ZodType<
          Record<string, unknown>
        >,
        strict: true,
        ...(index === entries.length - 1 && options.lastToolProviderOptions
          ? { providerOptions: options.lastToolProviderOptions }
          : {}),
        execute: async (input: Record<string, unknown>) => {
          const result = await execute(name, input, ctx);
          await record({
            tool: name,
            input: input ?? {},
            resultMeta: result.meta as Record<string, unknown>,
          });
          return result;
        },
        toModelOutput: ({ output }) =>
          toolModelOutput(name, output as ToolResult<unknown>),
      }),
    ])
  );
}

const line = z.number().int().min(1).nullish();

/**
 * executeTool's own validation, independent of the schemas the model sees
 * (the SDK checks those first): optional inputs may be null or left out, and
 * line numbers start at 1.
 */
const INPUTS = {
  list_files: z.strictObject({ glob: z.string() }),
  search_code: z.strictObject({
    pattern: z.string(),
    regex: z.boolean().nullish(),
    glob: z.string().nullish(),
    ignore_case: z.boolean().nullish(),
  }),
  read_file: z.strictObject({
    path: z.string(),
    start_line: line,
    end_line: line,
  }),
  get_issue: z.strictObject({ key: z.string() }),
  read_attachment: z.strictObject({
    issue_key: z.string(),
    attachment_id: z.string(),
  }),
  search_knowledge: z.strictObject({ query: z.string() }),
  read_knowledge: z.strictObject({ slug: z.string() }),
} as const;

/** The automatic context's inputs: the code tools also name the project. */
const AUTO_INPUTS = {
  list_projects: z.strictObject({}),
  list_files: INPUTS.list_files.extend({ project: z.string() }),
  search_code: INPUTS.search_code.extend({ project: z.string() }),
  read_file: INPUTS.read_file.extend({ project: z.string() }),
  get_issue: INPUTS.get_issue,
  read_attachment: INPUTS.read_attachment,
  search_knowledge: INPUTS.search_knowledge,
  read_knowledge: INPUTS.read_knowledge,
} as const;

export type ToolName = keyof typeof AUTO_INPUTS;

/** A project as list_projects returns it. */
export type ListedProject = {
  key: string;
  name: string;
  description: string | null;
  components: string[];
};

type BaseToolContext = {
  viewer: AssistantViewer;
  /** Jira attachments the user ticked on the message being answered. */
  attachments: AttachmentRef[];
};

/**
 * What the tools of one turn read. Pinned (a project's branches or an
 * environment): the question's snapshots, resolved up front. Automatic: the
 * code tools name a project, resolved by `snapshotsFor` against the user's
 * visible projects only (loaded once per project per turn).
 */
export type ToolContext =
  | (BaseToolContext & { mode: "pinned"; snaps: SnapshotRef[] })
  | (BaseToolContext & {
      mode: "auto";
      snapshotsFor: (
        projectKey: string
      ) => Promise<SnapshotRef[] | { error: "unknown_project" }>;
      listProjects: () => Promise<ListedProject[]>;
    });

const inputsOf = (ctx: ToolContext) =>
  (ctx.mode === "auto" ? AUTO_INPUTS : INPUTS) as Partial<
    Record<ToolName, z.ZodType>
  >;

function isToolName(
  name: string,
  inputs: Partial<Record<ToolName, z.ZodType>>
): name is ToolName {
  return Object.hasOwn(inputs, name);
}

const orUndefined = <T>(value: T | null | undefined): T | undefined =>
  value ?? undefined;

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  const inputs = inputsOf(ctx);
  if (!isToolName(name, inputs)) {
    return { ok: false, error: `unknown tool: ${name}`, meta: {} };
  }
  const parsed = (inputs[name] as z.ZodType).safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid input for ${name}: ${z.prettifyError(parsed.error)}`,
      meta: {},
    };
  }
  try {
    return await run(name, parsed.data, ctx);
  } catch (error) {
    // Unexpected failures (DB down, corrupt snapshot): the message stays generic
    // so an internal error text never reaches the model.
    console.error(`[assistant] tool ${name} failed`, error);
    return { ok: false, error: `${name} failed unexpectedly`, meta: {} };
  }
}

type CodeToolName = "list_files" | "search_code" | "read_file";

function runCode(
  name: CodeToolName,
  data: unknown,
  snaps: SnapshotRef[]
): Promise<ToolResult<unknown>> {
  switch (name) {
    case "list_files": {
      const i = data as z.infer<typeof INPUTS.list_files>;
      return listFiles(snaps, i.glob);
    }
    case "search_code": {
      const i = data as z.infer<typeof INPUTS.search_code>;
      return searchCode(snaps, {
        pattern: i.pattern,
        regex: orUndefined(i.regex),
        glob: orUndefined(i.glob),
        ignoreCase: orUndefined(i.ignore_case),
      });
    }
    case "read_file": {
      const i = data as z.infer<typeof INPUTS.read_file>;
      return readFile(snaps, {
        path: i.path,
        startLine: orUndefined(i.start_line),
        endLine: orUndefined(i.end_line),
      });
    }
  }
}

/**
 * A code tool of the automatic context: only a project the user can see
 * (snapshotsFor checks) is read, and the audit records which project each
 * read belonged to, since paths are relative to it.
 */
async function runProjectCode(
  name: CodeToolName,
  data: unknown,
  ctx: Extract<ToolContext, { mode: "auto" }>
): Promise<ToolResult<unknown>> {
  const { project, ...input } = data as { project: string };
  const snaps = await ctx.snapshotsFor(project);
  if ("error" in snaps) {
    return {
      ok: false,
      error: `Unknown project ${project}. Call list_projects.`,
      meta: { project },
    };
  }
  if (snaps.length === 0) {
    return {
      ok: false,
      error: `No source code of project ${project} can be read.`,
      meta: { project },
    };
  }
  const result = await runCode(name, input, snaps);
  return { ...result, meta: { ...result.meta, project } };
}

async function run(
  name: ToolName,
  data: unknown,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  switch (name) {
    case "list_projects": {
      if (ctx.mode !== "auto") break;
      const projects = await ctx.listProjects();
      return {
        ok: true,
        data: { projects },
        meta: { projectKeys: projects.map((p) => p.key) },
      };
    }
    case "list_files":
    case "search_code":
    case "read_file":
      return ctx.mode === "auto"
        ? runProjectCode(name, data, ctx)
        : runCode(name, data, ctx.snaps);
    case "get_issue": {
      const i = data as z.infer<typeof INPUTS.get_issue>;
      return getIssueTool(ctx.viewer, i.key);
    }
    case "read_attachment": {
      const i = data as z.infer<typeof INPUTS.read_attachment>;
      return readAttachmentTool(ctx.viewer, ctx.attachments, {
        issueKey: i.issue_key,
        attachmentId: i.attachment_id,
      });
    }
    case "search_knowledge": {
      const i = data as z.infer<typeof INPUTS.search_knowledge>;
      return searchKnowledgeTool(ctx.viewer, i.query);
    }
    case "read_knowledge": {
      const i = data as z.infer<typeof INPUTS.read_knowledge>;
      return readKnowledgeTool(ctx.viewer, i.slug);
    }
  }
  return { ok: false, error: `unknown tool: ${name}`, meta: {} };
}

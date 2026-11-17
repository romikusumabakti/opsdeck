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

/** What the model sees: names, descriptions and input schemas. */
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
      start_line: nullable(
        z.number().int(),
        "First line to read (1-based). Default 1."
      ),
      end_line: nullable(z.number().int(), "Last line to read, inclusive."),
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
  const entries = Object.entries(DEFINITIONS) as Array<
    [ToolName, (typeof DEFINITIONS)[ToolName]]
  >;
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

export type ToolName = keyof typeof INPUTS;

export type ToolContext = {
  snaps: SnapshotRef[];
  viewer: AssistantViewer;
  /** Jira attachments the user ticked on the message being answered. */
  attachments: AttachmentRef[];
};

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(INPUTS, name);
}

const orUndefined = <T>(value: T | null | undefined): T | undefined =>
  value ?? undefined;

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  if (!isToolName(name)) {
    return { ok: false, error: `unknown tool: ${name}`, meta: {} };
  }
  const parsed = INPUTS[name].safeParse(input);
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

async function run(
  name: ToolName,
  data: unknown,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  switch (name) {
    case "list_files": {
      const i = data as z.infer<typeof INPUTS.list_files>;
      return listFiles(ctx.snaps, i.glob);
    }
    case "search_code": {
      const i = data as z.infer<typeof INPUTS.search_code>;
      return searchCode(ctx.snaps, {
        pattern: i.pattern,
        regex: orUndefined(i.regex),
        glob: orUndefined(i.glob),
        ignoreCase: orUndefined(i.ignore_case),
      });
    }
    case "read_file": {
      const i = data as z.infer<typeof INPUTS.read_file>;
      return readFile(ctx.snaps, {
        path: i.path,
        startLine: orUndefined(i.start_line),
        endLine: orUndefined(i.end_line),
      });
    }
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
}

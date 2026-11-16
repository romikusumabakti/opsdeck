import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AttachmentRef } from "./attachment-refs";
import {
  listFiles,
  MAX_LIST_PATHS,
  MAX_READ_BYTES,
  MAX_READ_LINES,
  MAX_SEARCH_MATCHES,
  readFile,
  type SnapshotRef,
  searchCode,
  type ToolResult,
} from "./tools/code";
import {
  getIssueTool,
  readAttachmentTool,
  readKnowledgeTool,
  searchKnowledgeTool,
} from "./tools/context";
import type { AssistantViewer } from "./viewer";

/**
 * The tools Claude may call, as strict Anthropic tool definitions, and the
 * dispatcher that validates each call's input and runs it for one viewer.
 * Strict mode: every object sets additionalProperties false and lists every
 * property as required; optional inputs are nullable instead.
 */

type Schema = Anthropic.Tool["input_schema"];

function object(properties: Record<string, Record<string, unknown>>): Schema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const str = (description: string) => ({ type: "string", description });
const nullable = (type: string, description: string) => ({
  type: [type, "null"],
  description,
});

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: `List file paths in the source snapshot of the environment's running commit, matching a glob (e.g. "backend/src/**/*.java"). Paths are prefixed with the component key. At most ${MAX_LIST_PATHS} paths; files holding secrets are withheld and only counted.`,
    strict: true,
    input_schema: object({
      glob: str('Glob relative to the snapshot root; "**/*" lists everything.'),
    }),
  },
  {
    name: "search_code",
    description: `Search file contents of the source snapshot. Returns at most ${MAX_SEARCH_MATCHES} matches with path, line number and ±2 lines of context. Literal match unless regex is true. Files holding secrets are never searched.`,
    strict: true,
    input_schema: object({
      pattern: str("Text (or regular expression when regex is true) to find."),
      regex: nullable(
        "boolean",
        "Treat pattern as a regular expression. Default false."
      ),
      glob: nullable("string", "Only search paths matching this glob."),
      ignore_case: nullable(
        "boolean",
        "Case-insensitive match. Default false."
      ),
    }),
  },
  {
    name: "read_file",
    description: `Read a file from the source snapshot by its component-prefixed path, optionally a 1-based line range. At most ${MAX_READ_LINES} lines or ${MAX_READ_BYTES / 1024} KiB per call; page with start_line for more. Files holding secrets are withheld.`,
    strict: true,
    input_schema: object({
      path: str(
        "Component-prefixed path as returned by list_files/search_code."
      ),
      start_line: nullable(
        "integer",
        "First line to read (1-based). Default 1."
      ),
      end_line: nullable("integer", "Last line to read, inclusive."),
    }),
  },
  {
    name: "get_issue",
    description:
      "Get a Jira issue mirrored in the Panel for a project the user can see: title, status, type, description, comments (latest 100) and the attachment list (names, types, sizes only). Unknown or invisible keys return not found.",
    strict: true,
    input_schema: object({
      key: str('Jira issue key, e.g. "KST-123".'),
    }),
  },
  {
    name: "read_attachment",
    description:
      "Read the content of one Jira attachment the user ticked for this message (other attachments are refused). PDF (≤15 MiB) and PNG/JPEG/GIF/WebP images (≤5 MiB) are returned as-is; XLSX is converted to CSV text per sheet (≤200 KiB) with yellow-highlighted cells marked [highlight] and cell notes as [note: …]. Other formats are not supported.",
    strict: true,
    input_schema: object({
      issue_key: str(
        "Key of the issue the attachment belongs to, as listed with the ticked attachments."
      ),
      attachment_id: str(
        "Attachment id, as listed with the ticked attachments (or in get_issue's attachment list)."
      ),
    }),
  },
  {
    name: "search_knowledge",
    description:
      "Full-text search of the Panel knowledge base (documents the user can read). Returns up to 20 hits with slug, title and a snippet.",
    strict: true,
    input_schema: object({
      query: str("Search terms; supports quoted phrases, OR and -exclusion."),
    }),
  },
  {
    name: "read_knowledge",
    description:
      "Read a knowledge-base document by slug as markdown (at most 64 KiB). Drafts the user cannot see return not found.",
    strict: true,
    input_schema: object({
      slug: str("Document slug from search_knowledge."),
    }),
  },
];

const line = z.number().int().min(1).nullish();

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

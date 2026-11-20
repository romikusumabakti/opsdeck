import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny local stand-in for an OpenAI-compatible chat-completions API, so the
 * assistant specs never reach a real provider. It streams one text answer per
 * request. A question containing "use a tool" (with no tool result in the
 * request yet) streams a preamble and then a `list_issues` call, every
 * argument null; once the request holds the tool's result it streams the
 * final answer.
 *
 * A question containing "slow" streams a word every STEP_MS for a long time,
 * so a spec can click Stop mid-answer; only its first request is slow, so a
 * Retry of the same question answers at once.
 *
 * A non-streaming request is the chat's auto title (lib/assistant/title.ts,
 * prompt "Question: …"): it answers with the question's first line, so
 * titles stay what the specs typed, or with NAMED_TITLE for a question
 * containing "name me", so a spec can see a generated title arrive.
 */
export const NAMED_TITLE = "Named by the stub";

function titleFor(prompt: string): string {
  const question = prompt.split("\n")[1] ?? "";
  return question.includes("name me") ? NAMED_TITLE : question;
}
const STEP_MS = 300;
const SLOW_WORDS = 100;
const FAST_ANSWER = [
  "The",
  " login",
  " lives",
  " in",
  " the",
  " auth",
  " module.",
];

type Part = { type?: string; text?: string };
type ChatMessage = { role?: string; content?: string | Part[] | null };

const TOOL_PREAMBLE = ["Checking", " the", " issues."];
// Held before the final text of a tool turn, so a spec can reliably observe
// the interim step (it folds away once the answer finishes).
const TOOL_FINAL_DELAY_MS = 1500;
const TOOL_FINAL = ["No", " issues", " match."];
// list_issues' strict schema: every field is present and nullable.
const LIST_ISSUES_ARGS = JSON.stringify({
  query: null,
  project: null,
  status: null,
  type: null,
  priority: null,
  assignee: null,
  reporter: null,
  labels: null,
  environment: null,
  milestone: null,
  created_from: null,
  created_to: null,
  updated_from: null,
  updated_to: null,
  sort: null,
  order: null,
  limit: null,
  offset: null,
});

function lastUserText(messages: ChatMessage[]): string {
  const last = messages.findLast((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return (last.content ?? []).map((p) => p.text ?? "").join("\n");
}

export type AssistantStub = {
  /** The base URL to configure as the provider's (ends in /v1). */
  baseUrl: string;
  close: () => Promise<void>;
};

export async function startAssistantStub(): Promise<AssistantStub> {
  const seenSlow = new Set<string>();
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: ChatMessage[];
        model?: string;
        stream?: boolean;
      };
      const question = lastUserText(body.messages ?? []);
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-stub",
            object: "chat.completion",
            created: 0,
            model: body.model ?? "stub-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: titleFor(question) },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 50,
              completion_tokens: 5,
              total_tokens: 55,
            },
          })
        );
        return;
      }
      const slow = question.includes("slow") && !seenSlow.has(question);
      if (slow) seenSlow.add(question);
      const messages = body.messages ?? [];
      const hasToolResult = messages.some((m) => m.role === "tool");
      const callsTool = question.includes("use a tool") && !hasToolResult;
      let words = slow
        ? Array.from({ length: SLOW_WORDS }, (_, i) => `word${i} `)
        : FAST_ANSWER;
      if (callsTool) words = TOOL_PREAMBLE;
      else if (question.includes("use a tool")) words = TOOL_FINAL;

      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion.chunk",
          created: 0,
          model: body.model ?? "stub-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write(chunk({ role: "assistant", content: "" }));
      let index = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      const start = () => {
        timer = setInterval(
          () => {
            const word = words[index++];
            if (word !== undefined) {
              res.write(chunk({ content: word }));
              return;
            }
            clearInterval(timer);
            if (callsTool) {
              res.write(
                chunk({
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_stub_1",
                      type: "function",
                      function: {
                        name: "list_issues",
                        arguments: LIST_ISSUES_ARGS,
                      },
                    },
                  ],
                })
              );
            }
            res.write(chunk({}, callsTool ? "tool_calls" : "stop"));
            res.write(
              `data: ${JSON.stringify({
                id: "chatcmpl-stub",
                object: "chat.completion.chunk",
                created: 0,
                model: body.model ?? "stub-model",
                choices: [],
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 20,
                  total_tokens: 120,
                },
              })}\n\n`
            );
            res.end("data: [DONE]\n\n");
          },
          slow ? STEP_MS : 20
        );
      };
      const hold =
        hasToolResult && question.includes("use a tool")
          ? setTimeout(start, TOOL_FINAL_DELAY_MS)
          : undefined;
      if (!hold) start();
      res.on("close", () => {
        clearTimeout(hold);
        clearInterval(timer);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

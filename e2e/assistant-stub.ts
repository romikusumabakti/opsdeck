import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny local stand-in for an OpenAI-compatible chat-completions API, so the
 * assistant specs never reach a real provider. It streams one text answer per
 * request and never calls a tool.
 *
 * A question containing "slow" streams a word every STEP_MS for a long time,
 * so a spec can click Stop mid-answer; only its first request is slow, so a
 * Retry of the same question answers at once.
 */
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
      };
      const question = lastUserText(body.messages ?? []);
      const slow = question.includes("slow") && !seenSlow.has(question);
      if (slow) seenSlow.add(question);
      const words = slow
        ? Array.from({ length: SLOW_WORDS }, (_, i) => `word${i} `)
        : FAST_ANSWER;

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
      const timer = setInterval(
        () => {
          const word = words[index++];
          if (word !== undefined) {
            res.write(chunk({ content: word }));
            return;
          }
          clearInterval(timer);
          res.write(chunk({}, "stop"));
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
      res.on("close", () => clearInterval(timer));
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

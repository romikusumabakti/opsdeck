import { type ChatTransport, DefaultChatTransport, type UIMessage } from "ai";
import { answerStreamUrl } from "@/web/api/assistant";

type SendOptions = Parameters<ChatTransport<UIMessage>["sendMessages"]>[0];

/**
 * The Assistant's `useChat` transport. It only follows answers: a turn is
 * created by the JSON routes (send-message, retry-answer,
 * edit-last-question), which keep their refusals and error codes, and the
 * chat then reads it from GET /answer-stream (the chat id is the
 * conversation id). That route replays the running answer from its first
 * chunk, or is a 204 when none runs (the SDK reads a 204 as "no stream").
 */
export class AssistantChatTransport extends DefaultChatTransport<UIMessage> {
  constructor() {
    super({
      prepareReconnectToStreamRequest: ({ id }) => ({
        api: answerStreamUrl(id),
        credentials: "include",
      }),
    });
  }

  /** Never posts the chat: follows the answer the routes already started. */
  override async sendMessages(options: SendOptions) {
    return (
      (await this.reconnectToStream(options)) ??
      new ReadableStream({ start: (controller) => controller.close() })
    );
  }
}

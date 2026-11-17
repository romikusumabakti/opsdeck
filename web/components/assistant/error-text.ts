import { useTranslations } from "use-intl";
import { ASSISTANT_ERROR_MESSAGE_KEYS } from "@/lib/assistant/errors";
import { ApiError } from "@/web/api/client";

type ErrorParams = Record<string, string | number> | undefined;

function isKnownCode(
  code: string
): code is keyof typeof ASSISTANT_ERROR_MESSAGE_KEYS {
  return Object.hasOwn(ASSISTANT_ERROR_MESSAGE_KEYS, code);
}

/**
 * The one place the chat words an assistant error code (a refused request's
 * ApiError or a failed message's `errorCode`) with the `assistantErrors`
 * messages. The daily cap's `resetsAt` (ISO) is formatted as a time in the
 * reader's zone by the message itself; unknown codes read as "failed".
 */
export function useAssistantErrorText() {
  const t = useTranslations("assistantErrors");
  const tAssistant = useTranslations("assistant");

  const codeText = (code: string | null | undefined, params?: ErrorParams) => {
    const key =
      code && isKnownCode(code) ? ASSISTANT_ERROR_MESSAGE_KEYS[code] : "failed";
    if (key === "dailyCapReached") {
      return t(key, {
        capUsd: Number(params?.capUsd ?? 0),
        resetsAt: new Date(String(params?.resetsAt ?? Date.now())),
      });
    }
    return t(key);
  };

  const errorText = (error: unknown) => {
    if (error instanceof ApiError) {
      if (error.code && isKnownCode(error.code)) {
        return codeText(error.code, error.params);
      }
      if (error.status === 403) return tAssistant("noIssueWrite");
      if (error.status === 404) return tAssistant("notFound");
    }
    return codeText("assistant.failed");
  };

  return { codeText, errorText };
}

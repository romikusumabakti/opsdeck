import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, SendHorizontal } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { SearchSelect } from "@/components/search-select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import {
  createConversation,
  getAllowanceQuery,
  sendMessage,
} from "@/web/api/assistant";
import { listProjectsQuery } from "@/web/api/project-catalog";
import { shouldSend } from "@/web/components/assistant/composer-keys";
import { useAssistantErrorText } from "@/web/components/assistant/error-text";
import { HomeSection } from "./home-section";

/**
 * Starts a conversation pinned to a project from Home: pick a project (the
 * first by default), type a question, Enter. The answer is
 * followed on the project's Assistant page, which the send navigates to.
 * Hidden unless the assistant is on and the user sees a project.
 */
export function AskAssistantCard() {
  const t = useTranslations("homePage");
  const tAssistant = useTranslations("assistant");
  const { codeText, errorText } = useAssistantErrorText();
  const router = useRouter();
  const allowance = useQuery(getAllowanceQuery()).data;
  const projects = useQuery(listProjectsQuery()).data;
  const [picked, setPicked] = React.useState<string | null>(null);
  const [text, setText] = React.useState("");

  // The conversation made for a send that then failed: a retry for the same
  // project reuses it instead of leaving another empty one behind.
  const created = React.useRef<{ projectId: string; id: string } | null>(null);

  const ask = useMutation({
    mutationFn: async (input: { projectKey: string; projectId: string }) => {
      if (created.current?.projectId !== input.projectId) {
        const { id } = await createConversation();
        created.current = { projectId: input.projectId, id };
      }
      const { id } = created.current;
      await sendMessage({
        conversationId: id,
        text: text.trim(),
        context: { kind: "project", projectId: input.projectId },
      });
      created.current = null;
      return { projectKey: input.projectKey, conversationId: id };
    },
    onSuccess: ({ projectKey, conversationId }) =>
      router.push(`/${projectKey}/assistant?c=${conversationId}`),
  });

  if (!allowance?.enabled || !projects || projects.length === 0) return null;

  const project = projects.find((p) => p.id === picked) ?? projects[0];
  if (!project) return null;

  const capped = allowance.capReached;
  const canSend =
    !capped && !ask.isPending && !ask.isSuccess && text.trim() !== "";
  const submit = () => {
    if (canSend) ask.mutate({ projectKey: project.key, projectId: project.id });
  };
  const message = capped
    ? codeText("assistant.daily_cap_reached", { resetsAt: allowance.resetsAt })
    : ask.isError
      ? errorText(ask.error)
      : null;

  return (
    <HomeSection icon={Bot} title={t("askTitle")}>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-start gap-2">
          <SearchSelect
            value={project.id}
            onChange={(id) => id && setPicked(id)}
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
            placeholder={t("askProject")}
            aria-label={t("askProject")}
            disabled={ask.isPending}
            className="w-40 shrink-0 sm:w-48"
          />
          <Textarea
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (shouldSend(e.nativeEvent)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t("askPlaceholder")}
            aria-label={t("askPlaceholder")}
            disabled={capped || ask.isPending}
            className="h-9 min-h-9 max-h-32 resize-none py-1.5"
          />
          <Button
            size="icon"
            aria-label={tAssistant("send")}
            disabled={!canSend}
            onClick={submit}
          >
            <SendHorizontal />
          </Button>
        </div>
        {message ? (
          <p
            role={capped ? "status" : "alert"}
            className={cn(
              "text-xs",
              capped ? "text-amber-600 dark:text-amber-500" : "text-destructive"
            )}
          >
            {message}
          </p>
        ) : null}
      </div>
    </HomeSection>
  );
}

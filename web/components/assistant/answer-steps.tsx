import { ChevronRight, Loader2, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { type AnswerStep, type ToolPart, toolSubject } from "./answer-layout";
import { toolLabelKey } from "./message-sources";

function ToolChip({ tool }: { tool: ToolPart }) {
  const t = useTranslations("assistant");
  const input =
    typeof tool.input === "object" && tool.input !== null
      ? (tool.input as Record<string, unknown>)
      : {};
  const subject = toolSubject(input);
  const label = t(toolLabelKey(tool.toolName));
  const running =
    tool.state === "input-streaming" || tool.state === "input-available";
  return (
    <li
      data-tool-chip={tool.state}
      className="flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs text-muted-foreground"
    >
      {running && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {tool.state === "output-error" && (
        <TriangleAlert className="size-3 text-destructive" aria-hidden />
      )}
      <span className="truncate">
        {subject ? `${label} · ${subject}` : label}
      </span>
    </li>
  );
}

/**
 * The steps an answer took before it: each step's text, muted, then a chip
 * per tool it called. A collapsible group, open while the answer streams
 * and folded once `collapsed` (a finished answer); the reader can open it
 * again. `renderText` renders a step's text (markdown).
 */
export function AnswerSteps({
  steps,
  collapsed,
  renderText,
}: {
  steps: AnswerStep[];
  collapsed: boolean;
  renderText: (text: string) => React.ReactNode;
}) {
  const t = useTranslations("assistant");
  const [open, setOpen] = React.useState(!collapsed);
  // Folds when the answer finishes; a reader's own toggle stays until then.
  const [seenCollapsed, setSeenCollapsed] = React.useState(collapsed);
  if (seenCollapsed !== collapsed) {
    setSeenCollapsed(collapsed);
    setOpen(!collapsed);
  }
  if (steps.length === 0) return null;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-answer-steps=""
      className="text-sm"
    >
      <CollapsibleTrigger className="group flex w-fit items-center gap-1 rounded-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight className="size-4 transition-transform group-data-[panel-open]:rotate-90" />
        {t("toolSteps", { count: steps.length })}
        <span className="sr-only">
          {open ? t("hideSteps") : t("showSteps")}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-3 border-s ps-3">
        {steps.map((step, index) => (
          <div
            // Steps only grow at the end, never reorder.
            key={index}
            data-answer-step=""
            className="flex flex-col gap-1.5"
          >
            {step.text.trim() !== "" && (
              <div data-step-text="" className="text-muted-foreground">
                {renderText(step.text)}
              </div>
            )}
            {step.tools.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {step.tools.map((tool) => (
                  <ToolChip key={tool.toolCallId} tool={tool} />
                ))}
              </ul>
            )}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

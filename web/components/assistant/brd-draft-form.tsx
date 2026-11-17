import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { BrdDraft } from "@/lib/assistant/drafts";
import { type ConversationDraft, saveDraft } from "@/web/api/assistant";
import { useAssistantErrorText } from "./error-text";

function toBrd(content: Record<string, unknown>): BrdDraft {
  const sections = Array.isArray(content.sections) ? content.sections : [];
  return {
    title: typeof content.title === "string" ? content.title : "",
    sections: sections.map((s: { heading?: unknown; body?: unknown }) => ({
      heading: typeof s?.heading === "string" ? s.heading : "",
      body: typeof s?.body === "string" ? s.body : "",
    })),
  };
}

/** The BRD as markdown, to paste into the BRD document. */
export function brdMarkdown(brd: BrdDraft): string {
  return [
    `# ${brd.title}`,
    ...brd.sections.map((s) => `## ${s.heading}\n\n${s.body}`),
  ].join("\n\n");
}

/** A BRD draft: title and sections, edited in place and saved. */
export function BrdDraftForm({ draft }: { draft: ConversationDraft }) {
  const t = useTranslations("assistant");
  const { errorText } = useAssistantErrorText();
  const saved = React.useMemo(() => toBrd(draft.content), [draft.content]);
  const [brd, setBrd] = React.useState<BrdDraft>(saved);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const dirty = JSON.stringify(brd) !== JSON.stringify(saved);

  const setSection = (index: number, patch: Partial<BrdDraft["sections"][0]>) =>
    setBrd((prev) => ({
      ...prev,
      sections: prev.sections.map((s, i) =>
        i === index ? { ...s, ...patch } : s
      ),
    }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveDraft({ draftId: draft.id, content: brd });
      toast.success(t("draftSaved"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const id = (field: string) => `draft-${draft.id}-${field}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id("title")}>{t("fieldTitle")}</Label>
        <Input
          id={id("title")}
          value={brd.title}
          onChange={(e) =>
            setBrd((prev) => ({ ...prev, title: e.target.value }))
          }
          maxLength={255}
        />
      </div>
      {brd.sections.map((section, index) => (
        // Sections have no ids; their order is fixed while editing.
        <fieldset key={index} className="flex flex-col gap-1.5">
          <Label htmlFor={id(`heading-${index}`)} className="sr-only">
            {t("fieldHeading")}
          </Label>
          <Input
            id={id(`heading-${index}`)}
            value={section.heading}
            onChange={(e) => setSection(index, { heading: e.target.value })}
            maxLength={200}
            className="font-medium"
          />
          <Label htmlFor={id(`body-${index}`)} className="sr-only">
            {t("fieldBody")}
          </Label>
          <Textarea
            id={id(`body-${index}`)}
            value={section.body}
            onChange={(e) => setSection(index, { body: e.target.value })}
            rows={4}
            maxLength={8000}
          />
        </fieldset>
      ))}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={save}
          disabled={!dirty || busy}
        >
          {t("saveDraft")}
        </Button>
        <CopyButton
          value={brdMarkdown(brd)}
          label={t("copyMarkdown")}
          variant="outline"
        />
      </div>
    </div>
  );
}

import { useTranslations } from "use-intl";
import {
  KnowledgeEditor,
  type LinkableDoc,
} from "@/components/knowledge-editor";

/**
 * KnowledgeEditor with the toolbar/link/upload labels wired to the shared
 * `knowledge` message namespace. Every markdown field in the app (knowledge
 * documents, issue descriptions) renders through this so the editing surface
 * and its translations stay in one place instead of being re-declared per call
 * site.
 *
 * The placeholder defaults to the `/` command hint (callers that pass their
 * own keep the hint in it); `borderless` drops the
 * frame for surfaces that sit directly in a page (issue descriptions).
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  linkableDocs = [],
  contentClassName,
  borderless = false,
  onBlur,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  linkableDocs?: LinkableDoc[];
  contentClassName?: string;
  borderless?: boolean;
  /** Focus left the editor; gets the (flushed) markdown. */
  onBlur?: (markdown: string) => void;
}) {
  const t = useTranslations("knowledge");

  return (
    <KnowledgeEditor
      value={value}
      onChange={onChange}
      placeholder={placeholder ?? t("editorPlaceholder")}
      linkableDocs={linkableDocs}
      contentClassName={contentClassName}
      borderless={borderless}
      onBlur={onBlur}
      linkLabels={{
        title: t("linkDocument"),
        search: t("searchPlaceholder"),
        empty: t("searchNoResults"),
      }}
      linkInputLabels={{
        label: t("linkUrl"),
        placeholder: t("linkUrlPlaceholder"),
        apply: t("linkApply"),
        remove: t("linkRemove"),
      }}
      uploadLabels={{
        uploading: t("imageUploading"),
        tooLarge: t("imageTooLarge"),
        failed: t("imageUploadFailed"),
      }}
      tableLabels={{
        addRow: t("tableAddRow"),
        deleteRow: t("tableDeleteRow"),
        addColumn: t("tableAddColumn"),
        deleteColumn: t("tableDeleteColumn"),
        deleteTable: t("tableDelete"),
      }}
      imageAltLabels={{
        edit: t("imageAltEdit"),
        placeholder: t("imageAltPlaceholder"),
        apply: t("linkApply"),
        remove: t("imageRemove"),
      }}
      toolbarLabels={{
        toolbar: t("editorToolbar"),
        tableMenu: t("editorTableMenu"),
        imageMenu: t("editorImageMenu"),
        bold: t("editorBold"),
        italic: t("editorItalic"),
        strikethrough: t("editorStrikethrough"),
        heading2: t("editorHeading2"),
        heading3: t("editorHeading3"),
        bulletList: t("editorBulletList"),
        orderedList: t("editorOrderedList"),
        taskList: t("editorTaskList"),
        code: t("editorInlineCode"),
        quote: t("editorQuote"),
      }}
      slashLabels={{
        menu: t("slashMenu"),
        empty: t("slashEmpty"),
        heading2: t("editorHeading2"),
        heading3: t("editorHeading3"),
        bulletList: t("slashBulletList"),
        orderedList: t("slashNumberedList"),
        taskList: t("editorTaskList"),
        quote: t("editorQuote"),
        codeBlock: t("editorCodeBlock"),
        table: t("slashTable"),
        image: t("slashImage"),
        divider: t("slashDivider"),
        linkDocument: t("linkDocument"),
      }}
    />
  );
}

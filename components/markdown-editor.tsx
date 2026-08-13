"use client";

import { useTranslations } from "next-intl";
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
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  linkableDocs = [],
  contentClassName,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  linkableDocs?: LinkableDoc[];
  contentClassName?: string;
}) {
  const t = useTranslations("knowledge");

  return (
    <KnowledgeEditor
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      linkableDocs={linkableDocs}
      contentClassName={contentClassName}
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
        button: t("insertImage"),
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
      }}
      toolbarLabels={{
        toolbar: t("editorToolbar"),
        undo: t("editorUndo"),
        redo: t("editorRedo"),
        bold: t("editorBold"),
        italic: t("editorItalic"),
        strikethrough: t("editorStrikethrough"),
        heading2: t("editorHeading2"),
        heading3: t("editorHeading3"),
        bulletList: t("editorBulletList"),
        orderedList: t("editorOrderedList"),
        taskList: t("editorTaskList"),
        code: t("editorInlineCode"),
        codeBlock: t("editorCodeBlock"),
        quote: t("editorQuote"),
        insertTable: t("editorInsertTable"),
      }}
    />
  );
}

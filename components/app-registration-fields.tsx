import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type BuildSpec, buildSpecSchema } from "@/lib/ci/build-spec";
import { issueMessage } from "@/lib/ci/registration-issues";
import { cn } from "@/lib/utils";
import { pipelinePreviewQuery } from "@/web/api/apps";
import { ApiError } from "@/web/api/client";

// The build spec editor of a generated pipeline (images, bundle files,
// checks) with the YAML the Panel will commit to every built branch, and the
// draft helpers around it. The New environment page's pipeline choices use it.

type ImageDraft = { name: string; dockerfile: string; context: string };
type FileDraft = { from: string; to: string };
type CheckDraft = {
  name: string;
  image: string;
  dir: string;
  commands: string;
};
export type SpecDraft = {
  branches: string;
  tagShaLength: string;
  timeoutMinutes: string;
  images: ImageDraft[];
  bundleFiles: FileDraft[];
  checks: CheckDraft[];
};

export function defaultSpec(componentKey: string): SpecDraft {
  return {
    branches: "main",
    tagShaLength: "7",
    timeoutMinutes: "60",
    images: [{ name: componentKey, dockerfile: "Dockerfile", context: "." }],
    bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
    checks: [],
  };
}

/** A stored or suggested build spec as the editor's draft. */
export function specDraftOf(spec: BuildSpec): SpecDraft {
  return {
    branches: spec.branches.join(", "),
    tagShaLength: String(spec.tagShaLength),
    timeoutMinutes: String(spec.timeoutMinutes),
    images: spec.images.map((image) => ({ ...image })),
    bundleFiles: spec.bundleFiles.map((file) => ({ ...file })),
    checks: spec.checks.map((check) => ({
      name: check.name,
      image: check.image,
      dir: check.dir,
      commands: check.commands.join("\n"),
    })),
  };
}

/**
 * The translated issues of a draft spec, keyed `<path>.<field>` as
 * `SpecEditor` reads them (`appForm.issues` messages).
 */
export function useSpecIssues(spec: SpecDraft, path: string): Issues {
  const tIssues = useTranslations("appForm.issues");
  return useMemo(() => {
    const result = buildSpecSchema.safeParse(toSpec(spec));
    const issues: Issues = new Map();
    if (result.success) return issues;
    for (const issue of result.error.issues) {
      const key = [path, ...issue.path].join(".");
      if (issues.has(key)) continue;
      const { key: messageKey, values } = issueMessage(issue);
      issues.set(key, tIssues(messageKey, values));
    }
    return issues;
  }, [spec, path, tIssues]);
}

export function toSpec(draft: SpecDraft) {
  return {
    branches: draft.branches
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean),
    tagShaLength: Number(draft.tagShaLength),
    timeoutMinutes: Number(draft.timeoutMinutes),
    images: draft.images,
    bundleFiles: draft.bundleFiles,
    checks: draft.checks.map((check) => ({
      name: check.name,
      image: check.image,
      dir: check.dir,
      commands: check.commands
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    })),
  };
}

/**
 * Translated issue messages keyed by their dotted path, e.g.
 * "components.0.componentKey". The schema's own text is never shown: each
 * issue maps to an `appForm.issues` key (lib/ci/registration-issues.ts).
 */
export type Issues = Map<string, string>;

/** The first issue at `prefix` or below it. */
function issueAt(issues: Issues, prefix: string): string | undefined {
  for (const [key, message] of issues) {
    if (key === prefix || key.startsWith(`${prefix}.`)) return message;
  }
  return undefined;
}

function TextField({
  label,
  description,
  value,
  onChange,
  error,
  mono,
  readOnly,
  placeholder,
  type,
}: {
  label: string;
  description?: string;
  value: string;
  onChange?: (value: string) => void;
  error?: string;
  mono?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  type?: "text" | "number";
}) {
  const id = useId();
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type ?? "text"}
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={cn(mono && "font-mono")}
        onChange={(e) => onChange?.(e.target.value)}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}

/** The build spec editor of a generated pipeline, with the YAML preview. */
export function SpecEditor({
  componentKey,
  spec,
  issues,
  path,
  onChange,
}: {
  componentKey: string;
  spec: SpecDraft;
  issues: Issues;
  path: string;
  onChange: (change: (spec: SpecDraft) => SpecDraft) => void;
}) {
  const t = useTranslations("appForm");

  function setRow<K extends "images" | "bundleFiles" | "checks">(
    list: K,
    index: number,
    patch: Partial<SpecDraft[K][number]>
  ) {
    onChange((s) => ({
      ...s,
      [list]: s[list].map((row, i) =>
        i === index ? { ...row, ...patch } : row
      ),
    }));
  }

  function removeRow(list: "images" | "bundleFiles" | "checks", index: number) {
    onChange((s) => ({ ...s, [list]: s[list].filter((_, i) => i !== index) }));
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label={t("branches")}
          description={t("branchesDescription")}
          value={spec.branches}
          onChange={(branches) => onChange((s) => ({ ...s, branches }))}
          error={issueAt(issues, `${path}.branches`)}
          mono
        />
        <TextField
          label={t("tagShaLength")}
          type="number"
          value={spec.tagShaLength}
          onChange={(tagShaLength) => onChange((s) => ({ ...s, tagShaLength }))}
          error={issues.get(`${path}.tagShaLength`)}
        />
        <TextField
          label={t("timeoutMinutes")}
          type="number"
          value={spec.timeoutMinutes}
          onChange={(timeoutMinutes) =>
            onChange((s) => ({ ...s, timeoutMinutes }))
          }
          error={issues.get(`${path}.timeoutMinutes`)}
        />
      </div>

      <FieldSet>
        <FieldLegend variant="label">{t("images")}</FieldLegend>
        {spec.images.map((image, i) => (
          <RowFields
            key={i}
            onRemove={
              spec.images.length > 1 ? () => removeRow("images", i) : undefined
            }
            error={issueAt(issues, `${path}.images.${i}`)}
          >
            <Input
              aria-label={t("imageName")}
              placeholder={t("imageName")}
              className="font-mono"
              value={image.name}
              onChange={(e) => setRow("images", i, { name: e.target.value })}
            />
            <Input
              aria-label={t("dockerfile")}
              placeholder={t("dockerfile")}
              className="font-mono"
              value={image.dockerfile}
              onChange={(e) =>
                setRow("images", i, { dockerfile: e.target.value })
              }
            />
            <Input
              aria-label={t("context")}
              placeholder={t("context")}
              className="font-mono"
              value={image.context}
              onChange={(e) => setRow("images", i, { context: e.target.value })}
            />
          </RowFields>
        ))}
        <AddRow
          label={t("addImage")}
          onClick={() =>
            onChange((s) => ({
              ...s,
              images: [...s.images, { name: "", dockerfile: "", context: "." }],
            }))
          }
        />
        {issues.get(`${path}.images`) && (
          <FieldError>{issues.get(`${path}.images`)}</FieldError>
        )}
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">{t("bundleFiles")}</FieldLegend>
        <FieldDescription>{t("bundleFilesDescription")}</FieldDescription>
        {spec.bundleFiles.map((file, i) => (
          <RowFields
            key={i}
            onRemove={
              spec.bundleFiles.length > 1
                ? () => removeRow("bundleFiles", i)
                : undefined
            }
            error={issueAt(issues, `${path}.bundleFiles.${i}`)}
          >
            <Input
              aria-label={t("fileFrom")}
              placeholder={t("fileFrom")}
              className="font-mono"
              value={file.from}
              onChange={(e) =>
                setRow("bundleFiles", i, { from: e.target.value })
              }
            />
            <Input
              aria-label={t("fileTo")}
              placeholder={t("fileTo")}
              className="font-mono"
              value={file.to}
              onChange={(e) => setRow("bundleFiles", i, { to: e.target.value })}
            />
          </RowFields>
        ))}
        <AddRow
          label={t("addFile")}
          onClick={() =>
            onChange((s) => ({
              ...s,
              bundleFiles: [...s.bundleFiles, { from: "", to: "" }],
            }))
          }
        />
        {issues.get(`${path}.bundleFiles`) && (
          <FieldError>{issues.get(`${path}.bundleFiles`)}</FieldError>
        )}
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">{t("checks")}</FieldLegend>
        <FieldDescription>{t("checksDescription")}</FieldDescription>
        {spec.checks.map((check, i) => (
          <RowFields
            key={i}
            onRemove={() => removeRow("checks", i)}
            error={issueAt(issues, `${path}.checks.${i}`)}
          >
            <div className="flex flex-1 flex-col gap-2">
              <div className="grid gap-2 sm:grid-cols-3">
                <Input
                  aria-label={t("checkName")}
                  placeholder={t("checkName")}
                  className="font-mono"
                  value={check.name}
                  onChange={(e) =>
                    setRow("checks", i, { name: e.target.value })
                  }
                />
                <Input
                  aria-label={t("checkImage")}
                  placeholder={t("checkImage")}
                  className="font-mono"
                  value={check.image}
                  onChange={(e) =>
                    setRow("checks", i, { image: e.target.value })
                  }
                />
                <Input
                  aria-label={t("checkDir")}
                  placeholder={t("checkDir")}
                  className="font-mono"
                  value={check.dir}
                  onChange={(e) => setRow("checks", i, { dir: e.target.value })}
                />
              </div>
              <Textarea
                aria-label={t("checkCommands")}
                placeholder={t("checkCommands")}
                className="font-mono text-xs"
                rows={3}
                value={check.commands}
                onChange={(e) =>
                  setRow("checks", i, { commands: e.target.value })
                }
              />
            </div>
          </RowFields>
        ))}
        <AddRow
          label={t("addCheck")}
          onClick={() =>
            onChange((s) => ({
              ...s,
              checks: [
                ...s.checks,
                { name: "", image: "", dir: ".", commands: "" },
              ],
            }))
          }
        />
        {issues.get(`${path}.checks`) && (
          <FieldError>{issues.get(`${path}.checks`)}</FieldError>
        )}
      </FieldSet>

      <PipelinePreview componentKey={componentKey} spec={spec} />
    </div>
  );
}

function RowFields({
  children,
  onRemove,
  error,
}: {
  children: React.ReactNode;
  onRemove?: () => void;
  error?: string;
}) {
  const t = useTranslations("appForm");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-wrap gap-2 sm:flex-nowrap">
          {children}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          disabled={!onRemove}
          aria-label={t("removeRow")}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="self-start"
      onClick={onClick}
    >
      <Plus className="size-4" />
      {label}
    </Button>
  );
}

/** The YAML the Panel will commit for this spec, rendered by the server. */
function PipelinePreview({
  componentKey,
  spec,
}: {
  componentKey: string;
  spec: SpecDraft;
}) {
  const t = useTranslations("appForm");
  // Typing should not send a request per key stroke.
  const [debounced, setDebounced] = useState(spec);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(spec), 400);
    return () => clearTimeout(timer);
  }, [spec]);

  const parsed = buildSpecSchema.safeParse(toSpec(debounced));
  const ready =
    parsed.success && /^[a-z0-9][a-z0-9-]{0,63}$/.test(componentKey);
  const preview = useQuery(
    pipelinePreviewQuery(
      componentKey,
      ready ? (parsed.data as BuildSpec) : null
    )
  );

  return (
    <Field>
      <FieldLabel>{t("preview")}</FieldLabel>
      {!ready && !preview.data ? (
        <p className="text-sm text-muted-foreground">
          {t("previewIncomplete")}
        </p>
      ) : preview.isError ? (
        <p className="text-sm text-destructive">
          {preview.error instanceof ApiError
            ? preview.error.message
            : t("previewFailed")}
        </p>
      ) : (
        <pre
          className={cn(
            "max-h-96 overflow-auto rounded-lg border bg-muted p-3 font-mono text-xs",
            (!ready || preview.isFetching) && "opacity-60"
          )}
        >
          {preview.data?.yaml ?? t("previewLoading")}
        </pre>
      )}
    </Field>
  );
}

import { useMutation } from "@tanstack/react-query";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { parseDotenv } from "@/lib/variables/dotenv";
import {
  IMPORT_TEXT_MAX_BYTES,
  IMPORT_TEXT_MAX_ENTRIES,
  type ImportRow,
  type ImportSkipReason,
} from "@/lib/variables/import-rows";
import { ApiError } from "@/web/api/client";
import {
  type ImportReviewDir,
  previewTextImport,
  readServerImport,
  saveImport,
} from "@/web/api/variables";
import {
  DirStatusStrip,
  type ImportChoice,
  type ImportChoices,
  ImportReviewGroups,
  ImportReviewTable,
  initialChoices,
  isSaveable,
} from "./import-review";
import { useVariableErrorText } from "./variable-form-dialog";

type Source = "paste" | "upload" | "server";

type TextPreview = Awaited<ReturnType<typeof previewTextImport>>;

/**
 * The preview of one text tab (Paste or Upload), with its own pending and
 * error state. A result counts only while it is still the tab's text: an
 * edit or another file during the request drops it. `gcTime: 0` so the text
 * (secrets included) leaves the mutation cache once the dialog closes.
 */
function useTextPreview(
  environmentId: string,
  current: React.RefObject<string | null>,
  onReview: (text: string, result: TextPreview) => void,
  onError: (error: unknown) => void
) {
  return useMutation({
    mutationFn: (text: string) => previewTextImport(environmentId, text),
    gcTime: 0,
    onSuccess: (result, text) => {
      if (current.current === text) onReview(text, result);
    },
    onError: (error, text) => {
      if (current.current === text) onError(error);
    },
  });
}

type Review = {
  rows: ImportRow[];
  skipped: { name: string; reason: ImportSkipReason }[];
  choices: ImportChoices;
} & (
  | { source: "text"; text: string }
  | { source: "server"; dirs: ImportReviewDir[] }
);

const KIB = IMPORT_TEXT_MAX_BYTES / 1024;

/**
 * Localized text for an import failure: the import's own codes, then the
 * variables API's (escrow; the strong sign-in guidance apiFetch already
 * localized).
 */
function useImportErrorText() {
  const t = useTranslations("variables.import.errors");
  const variableErrorText = useVariableErrorText();
  return (error: unknown): string => {
    if (error instanceof ApiError && error.code) {
      // The limits are the client's own; `name`/`line` come with the code.
      const values = {
        kib: KIB,
        max: IMPORT_TEXT_MAX_ENTRIES,
        name: "",
        line: 0,
        ...error.params,
      };
      switch (error.code) {
        case "envTextTooLarge":
        case "envParseError":
        case "envTooManyEntries":
        case "importSourceRequired":
        case "importSourceUnknown":
        case "importRowUnknown":
        case "importRowDuplicate":
        case "importRowSame":
        case "importRowUnimportable":
        case "envFileChanged":
        case "variableEscrowed":
        case "variableImportFailed":
        case "envFileInvalid":
          return t(error.code, values);
      }
    }
    return variableErrorText(error);
  };
}

/**
 * "Import .env": one dialog for pasted, uploaded and server-read files. The
 * rows always come from the server (preview or read), which compares them
 * with the stored values, so no stored secret reaches the browser; the save
 * sends the reviewed text (or dir fingerprints) back to be re-validated.
 */
export function ImportEnvDialog({
  open,
  onOpenChange,
  environmentId,
  initialText,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  /** Pasted into the name field: opens on Paste, reviewed at once. */
  initialText?: string;
}) {
  const t = useTranslations("variables.import");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] max-h-[calc(100dvh-2rem)] sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every opening starts fresh. */}
        <ImportEnvBody
          environmentId={environmentId}
          initialText={initialText}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ImportEnvBody({
  environmentId,
  initialText,
  onDone,
}: {
  environmentId: string;
  initialText: string | undefined;
  onDone: () => void;
}) {
  const t = useTranslations("variables.import");
  const tCommon = useTranslations("common");
  const errorText = useImportErrorText();
  const [source, setSource] = React.useState<Source>("paste");
  const [pasteText, setPasteText] = React.useState(initialText ?? "");
  const [upload, setUpload] = React.useState<{
    name: string;
    notUtf8: boolean;
  } | null>(null);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [reviews, setReviews] = React.useState<Partial<Record<Source, Review>>>(
    {}
  );
  const [errors, setErrors] = React.useState<Partial<Record<Source, string>>>(
    {}
  );
  const [notice, setNotice] = React.useState<string | null>(null);
  // The text each text tab currently holds, for dropping stale previews.
  const pasteRef = React.useRef<string | null>(initialText ?? "");
  const uploadRef = React.useRef<string | null>(null);

  function setError(tab: Source, message: string | null) {
    setErrors(({ [tab]: _, ...rest }) =>
      message === null ? rest : { ...rest, [tab]: message }
    );
  }

  function textReview(tab: Source) {
    return (text: string, result: TextPreview) =>
      setReviews((prev) => ({
        ...prev,
        [tab]: {
          source: "text",
          text,
          rows: result.rows,
          skipped: result.skipped,
          choices: initialChoices(result.rows),
        },
      }));
  }

  const pastePreview = useTextPreview(
    environmentId,
    pasteRef,
    textReview("paste"),
    (e) => setError("paste", errorText(e))
  );
  const uploadPreview = useTextPreview(
    environmentId,
    uploadRef,
    textReview("upload"),
    (e) => setError("upload", errorText(e))
  );

  const serverRead = useMutation({
    mutationFn: () => readServerImport(environmentId),
    gcTime: 0,
    onMutate: () => setError("server", null),
    onSuccess: (result) =>
      setReviews((prev) => ({
        ...prev,
        server: {
          source: "server",
          dirs: result.dirs,
          rows: result.rows,
          skipped: result.skipped,
          choices: initialChoices(result.rows),
        },
      })),
    onError: (e) => setError("server", errorText(e)),
  });

  const save = useMutation({
    mutationFn: ({ review }: { review: Review; tab: Source }) => {
      const picked = review.rows.filter((row) =>
        isSaveable(row, review.choices[row.name])
      );
      if (review.source === "text") {
        return saveImport(environmentId, {
          source: "text",
          text: review.text,
          rows: picked.map((row) => ({
            name: row.name,
            kind: review.choices[row.name]?.kind ?? row.proposedKind,
          })),
        });
      }
      return saveImport(environmentId, {
        source: "server",
        dirs: review.dirs.flatMap((dir) =>
          dir.status === "ok" && dir.fingerprint
            ? [{ deployDir: dir.deployDir, fingerprint: dir.fingerprint }]
            : []
        ),
        rows: picked.map((row) => {
          const choice = review.choices[row.name];
          const kind = choice?.kind ?? row.proposedKind;
          return row.flags.differsAcrossDirs && choice?.valueId
            ? { name: row.name, kind, valueId: choice.valueId }
            : { name: row.name, kind };
        }),
      });
    },
    // The variables hold the reviewed text: keep it out of the cache.
    gcTime: 0,
    onMutate: ({ tab }) => {
      setError(tab, null);
      setNotice(null);
    },
    onSuccess: ({ imported, overwritten }) => {
      toast.success(t("imported", { count: imported, overwritten }));
      onDone();
    },
    onError: (e, { tab }) => {
      if (e instanceof ApiError && e.code === "envFileChanged") {
        // The review no longer matches the files: read them again.
        setNotice(errorText(e));
        serverRead.mutate();
        return;
      }
      setError(tab, errorText(e));
    },
  });

  // A paste into the name field is reviewed at once.
  const autoPreviewed = React.useRef(false);
  React.useEffect(() => {
    if (autoPreviewed.current || !initialText?.trim()) return;
    autoPreviewed.current = true;
    pastePreview.mutate(initialText);
  }, [initialText, pastePreview]);

  function onSourceChange(next: Source) {
    setSource(next);
    if (next === "server" && !reviews.server && !serverRead.isPending) {
      serverRead.mutate();
    }
  }

  function onPasteChange(text: string) {
    setPasteText(text);
    pasteRef.current = text;
    setError("paste", null);
    // The review belongs to the text it was made of.
    setReviews(({ paste: _, ...rest }) => rest);
  }

  async function onFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    // Cleared so that picking the same file again fires another change.
    input.value = "";
    uploadRef.current = null;
    setUploadError(null);
    setError("upload", null);
    setUpload(null);
    setReviews(({ upload: _, ...rest }) => rest);
    if (!file) return;
    if (file.size > IMPORT_TEXT_MAX_BYTES) {
      setUploadError(t("uploadTooLarge", { kib: KIB }));
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setUploadError(t("uploadReadFailed"));
      return;
    }
    uploadRef.current = text;
    // file.text() decodes as UTF-8 and replaces what is not with U+FFFD.
    setUpload({ name: file.name, notUtf8: text.includes("\uFFFD") });
    uploadPreview.mutate(text);
  }

  function onChoice(name: string, patch: Partial<ImportChoice>) {
    setReviews((prev) => {
      const review = prev[source];
      const current = review?.choices[name];
      if (!review || !current) return prev;
      return {
        ...prev,
        [source]: {
          ...review,
          choices: { ...review.choices, [name]: { ...current, ...patch } },
        },
      };
    });
  }

  const review = reviews[source];
  const error = errors[source] ?? null;
  const count = review
    ? review.rows.filter((row) => isSaveable(row, review.choices[row.name]))
        .length
    : 0;
  const loading = source === "server" && serverRead.isPending;

  return (
    <>
      <div className="-mx-6 flex min-h-0 flex-col gap-4 overflow-y-auto px-6">
        <Tabs
          value={source}
          onValueChange={(next) => onSourceChange(next as Source)}
        >
          <TabsList>
            <TabsTrigger value="paste">{t("sourcePaste")}</TabsTrigger>
            <TabsTrigger value="upload">{t("sourceUpload")}</TabsTrigger>
            <TabsTrigger value="server">{t("sourceServer")}</TabsTrigger>
          </TabsList>
          <TabsContent value="paste" className="pt-2">
            <PasteSource
              text={pasteText}
              onChange={onPasteChange}
              busy={pastePreview.isPending}
              onReview={() => pastePreview.mutate(pasteText)}
            />
          </TabsContent>
          <TabsContent value="upload" className="flex flex-col gap-3 pt-2">
            <Field data-invalid={uploadError !== null}>
              <FieldLabel htmlFor="import-env-file">
                {t("uploadLabel")}
              </FieldLabel>
              <Input
                id="import-env-file"
                type="file"
                aria-invalid={uploadError !== null}
                aria-busy={uploadPreview.isPending}
                onChange={(event) => void onFile(event.currentTarget)}
              />
              <FieldDescription>
                {upload
                  ? t("uploadedFile", { name: upload.name })
                  : t("uploadHint", { kib: KIB })}
              </FieldDescription>
              {uploadError && <FieldError>{uploadError}</FieldError>}
            </Field>
            {upload?.notUtf8 && (
              <Alert>
                <TriangleAlert />
                <AlertDescription>{t("uploadNotUtf8")}</AlertDescription>
              </Alert>
            )}
            {uploadPreview.isPending && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t("reviewing")}
              </p>
            )}
          </TabsContent>
          <TabsContent value="server" className="flex flex-col gap-3 pt-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground">{t("serverHint")}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={serverRead.isPending}
                onClick={() => {
                  setNotice(null);
                  serverRead.mutate();
                }}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={serverRead.isPending ? "animate-spin" : undefined}
                />
                {t("reload")}
              </Button>
            </div>
            {reviews.server?.source === "server" && (
              <DirStatusStrip dirs={reviews.server.dirs} />
            )}
          </TabsContent>
        </Tabs>

        {notice && source === "server" && (
          <Alert>
            <RefreshCw />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <TriangleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("serverLoading")}
          </p>
        )}

        {review && !loading && (
          <div className="flex flex-col gap-3">
            {review.rows.some((row) => row.state !== "same") ? (
              <ImportReviewTable
                rows={review.rows}
                choices={review.choices}
                onChange={onChoice}
              />
            ) : (
              <p className="text-muted-foreground">
                {source === "server" &&
                reviews.server?.source === "server" &&
                reviews.server.dirs.length === 0
                  ? t("noDirs")
                  : t("nothing")}
              </p>
            )}
            <ImportReviewGroups rows={review.rows} skipped={review.skipped} />
            <p className="text-xs text-muted-foreground">{t("notKept")}</p>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          {tCommon("cancel")}
        </Button>
        <Button
          disabled={!review || count === 0 || save.isPending || loading}
          onClick={() => review && save.mutate({ review, tab: source })}
        >
          {save.isPending && (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          )}
          {t("submit", { count })}
        </Button>
      </DialogFooter>
    </>
  );
}

function PasteSource({
  text,
  onChange,
  busy,
  onReview,
}: {
  text: string;
  onChange: (text: string) => void;
  busy: boolean;
  onReview: () => void;
}) {
  const t = useTranslations("variables.import");
  // Instant feedback only: the review itself is the server's.
  const parsed = React.useMemo(
    () => (text.trim() === "" ? null : parseDotenv(text)),
    [text]
  );
  const parseError = parsed && "error" in parsed ? parsed.error.line : null;

  return (
    <Field data-invalid={parseError !== null}>
      <FieldLabel htmlFor="import-env-text">{t("pasteLabel")}</FieldLabel>
      <Textarea
        id="import-env-text"
        value={text}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("pastePlaceholder")}
        spellCheck={false}
        autoComplete="off"
        dir="ltr"
        aria-invalid={parseError !== null}
        className="max-h-64 min-h-32 font-mono text-sm"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {parseError !== null ? (
          <FieldError>{t("parsedError", { line: parseError })}</FieldError>
        ) : (
          <FieldDescription>
            {parsed && "entries" in parsed
              ? t("parsedCount", { count: parsed.entries.length })
              : null}
          </FieldDescription>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || parsed === null || parseError !== null}
          onClick={onReview}
        >
          {busy && (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          )}
          {t("review")}
        </Button>
      </div>
    </Field>
  );
}

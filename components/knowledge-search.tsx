"use client";

import { FileText, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { searchKnowledge } from "@/actions/knowledge";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useRouter } from "@/i18n/navigation";

// Must match HL_START / HL_STOP in lib/knowledge.ts. Control chars, so the
// snippet is rendered as plain text split into spans — never as HTML.
const HL_START = String.fromCharCode(1);
const HL_STOP = String.fromCharCode(2);

type Hit = {
  id: string;
  title: string;
  slug: string;
  collectionId: string;
  snippet: string;
  rank: number;
};

// Split a ts_headline snippet on the highlight delimiters and bold the matched
// fragments. No dangerouslySetInnerHTML — the delimiters are control chars the
// document text can't contain.
function HighlightedSnippet({ snippet }: { snippet: string }) {
  const raw = snippet.split(HL_START).flatMap((chunk, i) => {
    if (i === 0) return [{ text: chunk, hl: false }];
    const [hit, ...rest] = chunk.split(HL_STOP);
    return [
      { text: hit, hl: true },
      { text: rest.join(HL_STOP), hl: false },
    ];
  });
  // Key by cumulative character offset — stable and unique without array index.
  let offset = 0;
  const parts = raw.map((p) => {
    const key = `${offset}-${p.hl ? 1 : 0}`;
    offset += p.text.length;
    return { ...p, key };
  });
  return (
    <span className="line-clamp-2 text-xs text-muted-foreground">
      {parts.map((p) =>
        p.hl ? (
          <mark
            key={p.key}
            className="bg-transparent font-medium text-foreground"
          >
            {p.text}
          </mark>
        ) : (
          <span key={p.key}>{p.text}</span>
        )
      )}
    </span>
  );
}

export function KnowledgeSearch() {
  const t = useTranslations("knowledge");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  // Guards against out-of-order responses: only the latest query's result wins.
  const seq = useRef(0);

  // Open with "/" while not typing in a field, like many doc tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !["INPUT", "TEXTAREA"].includes(
          (e.target as HTMLElement)?.tagName ?? ""
        ) &&
        !(e.target as HTMLElement)?.isContentEditable
      ) {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const mySeq = ++seq.current;
    const handle = setTimeout(async () => {
      const results = await searchKnowledge(q);
      if (mySeq !== seq.current) return; // a newer query superseded this one
      setHits(results);
      setLoading(false);
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  function go(slug: string) {
    setOpen(false);
    setQuery("");
    router.push(`/knowledge/${slug}`);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="mx-2 justify-start gap-2 font-normal text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
        {t("searchPlaceholder")}
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t("searchTitle")}
        description={t("searchPlaceholder")}
        shouldFilter={false}
      >
        <CommandInput
          placeholder={t("searchPlaceholder")}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          {!loading && query.trim() && hits.length === 0 && (
            <CommandEmpty>{t("searchNoResults")}</CommandEmpty>
          )}
          {hits.length > 0 && (
            <CommandGroup heading={t("searchResults")}>
              {hits.map((hit) => (
                <CommandItem
                  key={hit.id}
                  value={hit.id}
                  onSelect={() => go(hit.slug)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <FileText className="size-3.5 text-muted-foreground" />
                    {hit.title}
                  </span>
                  {hit.snippet && <HighlightedSnippet snippet={hit.snippet} />}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}

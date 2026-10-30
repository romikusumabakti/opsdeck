import { Info } from "lucide-react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getMotif, type MotifSlug } from "@/lib/motifs";

/** A motif's cultural note: origin, local name, meaning, source. */
export function MotifInfo({ slug }: { slug: MotifSlug }) {
  const t = useTranslations("motifs");
  const motif = getMotif(slug);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        {t(`items.${slug}.region`)} · {t(`items.${slug}.medium`)}
      </p>
      {motif.localName ? (
        <p className="text-muted-foreground">
          {t("localName", { name: motif.localName })}
        </p>
      ) : null}
      <p>{t(`items.${slug}.meaning`)}</p>
      <a
        href={motif.sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="w-fit text-primary underline-offset-4 hover:underline"
      >
        {t("source")}
      </a>
      <p className="text-xs text-muted-foreground">{t("aiNote")}</p>
    </div>
  );
}

/** The footer button outside the app shell: "ⓘ Kawung · Yogyakarta". */
export function MotifInfoPopover({ slug }: { slug: MotifSlug }) {
  const t = useTranslations("motifs");
  const motif = getMotif(slug);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs font-normal text-muted-foreground"
          />
        }
      >
        <Info className="size-3.5" />
        {motif.name}
        <span className="hidden sm:inline">· {t(`items.${slug}.region`)}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80">
        <PopoverHeader>
          <PopoverTitle>{motif.name}</PopoverTitle>
        </PopoverHeader>
        <MotifInfo slug={slug} />
      </PopoverContent>
    </Popover>
  );
}

/** The same note as a dialog, opened from the user menu. */
export function MotifInfoDialog({
  slug,
  open,
  onOpenChange,
}: {
  slug: MotifSlug;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{getMotif(slug).name}</DialogTitle>
        </DialogHeader>
        <MotifInfo slug={slug} />
      </DialogContent>
    </Dialog>
  );
}

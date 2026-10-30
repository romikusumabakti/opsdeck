import type { ReactNode } from "react";
import { Copyright } from "@/components/copyright";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { MotifInfoPopover } from "@/components/motif-info";
import { MotifWatermark } from "@/components/motif-watermark";
import { ThemeToggle } from "@/components/theme-toggle";
import { dailyMotif } from "@/lib/motifs";
import { useBootstrap } from "@/web/api/session";

/**
 * The page around every screen outside the app shell (the port of the
 * signed-out branch of app/[locale]/layout.tsx): today's motif in two
 * corners and one footer row with the copyright and the locale and theme
 * controls.
 */
export function PublicFrame({ children }: { children: ReactNode }) {
  const { appTimeZone } = useBootstrap();
  // Same for everyone on the same day in the app's zone.
  const todayMotif = dailyMotif(new Date(), appTimeZone);
  return (
    <div className="relative isolate flex flex-col min-h-dvh overflow-clip bg-muted dark:bg-background">
      {/* Corner ornaments, letterhead-style on the diagonal that follows the
          reading direction: the motif upright in the bottom-end corner, where
          the eye comes to rest, and turned 180° in the top-start corner.
          Mirrored in RTL. Small screens keep only the bottom one. */}
      <MotifWatermark
        slug={todayMotif}
        className="absolute -z-10 bottom-0 end-0 rtl:-scale-x-100"
      />
      <MotifWatermark
        slug={todayMotif}
        className="absolute -z-10 top-0 start-0 hidden sm:block rotate-180 rtl:-scale-x-100"
      />
      {/* No `min-h-0`: the content must be allowed to push the page taller
          than the viewport on short screens rather than being clipped under
          the footer. */}
      <div className="flex-1 flex flex-col">{children}</div>
      {/* The two spacers keep the copyright optically centred while the
          controls sit at the inline end without overlapping it — `end` keeps
          that mirrored for RTL. */}
      <footer className="flex items-center gap-2 px-4 py-4">
        <div className="flex-1 flex justify-start">
          <MotifInfoPopover slug={todayMotif} />
        </div>
        <Copyright className="shrink-0" />
        <div className="flex-1 flex justify-end">
          {/* Grouped into a bordered pill so the two icon buttons read as a
              deliberate control rather than glyphs floating loose. */}
          <div className="flex items-center gap-0.5 rounded-full border bg-card/80 p-0.5 shadow-sm [&_button]:size-8 [&_button]:rounded-full">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </footer>
    </div>
  );
}

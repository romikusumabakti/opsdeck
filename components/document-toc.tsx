"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Heading = { id: string; text: string; level: number };

/**
 * On-page table of contents with scroll-spy. Reads h2/h3 headings (stamped with
 * ids by rehype-slug) from the rendered article rather than re-parsing markdown,
 * so it always matches what's on screen. `containerId` scopes the query to the
 * document body so sidebar/headers aren't picked up.
 */
export function DocumentToc({ containerId }: { containerId: string }) {
  const t = useTranslations("knowledge");
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = document.getElementById(containerId);
    if (!root) return;
    const els = Array.from(
      root.querySelectorAll<HTMLHeadingElement>("h2[id], h3[id]")
    );
    setHeadings(
      els.map((el) => ({
        id: el.id,
        text: el.textContent ?? "",
        level: el.tagName === "H2" ? 2 : 3,
      }))
    );

    // Highlight the heading nearest the top of the viewport.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 0 }
    );
    for (const el of els) observer.observe(el);
    return () => observer.disconnect();
  }, [containerId]);

  if (headings.length < 2) return null;

  return (
    <nav className="flex flex-col gap-2 text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("onThisPage")}
      </span>
      <ul className="flex flex-col gap-1 border-l">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={cn(
                "-ml-px block border-l py-0.5 text-muted-foreground transition-colors hover:text-foreground",
                h.level === 2 ? "pl-3" : "pl-6",
                activeId === h.id &&
                  "border-primary font-medium text-foreground"
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

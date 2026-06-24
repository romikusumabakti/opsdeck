"use client";

import { ChevronRight, FileText, Folder } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Link, usePathname } from "@/i18n/navigation";
import type { KnowledgeCollection, KnowledgeTreeNode } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

type TreeItem = KnowledgeTreeNode & { children: TreeItem[] };

// Assemble the flat (parent, position)-ordered rows into a nesting tree. Orphans
// (parent in another collection or since-deleted) surface at the root so a doc
// is never hidden by a dangling parentId.
function buildTree(nodes: KnowledgeTreeNode[]): Map<string, TreeItem[]> {
  const byId = new Map<string, TreeItem>();
  for (const n of nodes) byId.set(n.id, { ...n, children: [] });
  const roots = new Map<string, TreeItem[]>();
  for (const item of byId.values()) {
    const parent = item.parentId ? byId.get(item.parentId) : null;
    if (parent) {
      parent.children.push(item);
    } else {
      const list = roots.get(item.collectionId) ?? [];
      list.push(item);
      roots.set(item.collectionId, list);
    }
  }
  return roots;
}

function DocNode({
  node,
  depth,
  activeSlug,
}: {
  node: TreeItem;
  depth: number;
  activeSlug: string | null;
}) {
  const hasChildren = node.children.length > 0;
  const isActive = node.slug === activeSlug;
  const [open, setOpen] = useState(true);

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md pr-2 text-sm hover:bg-accent",
          isActive && "bg-accent font-medium"
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
            aria-label={open ? "Collapse" : "Expand"}
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform",
                open && "rotate-90"
              )}
            />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <Link
          href={`/knowledge/${node.slug}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5"
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "truncate",
              node.publishedAt === null && "text-muted-foreground italic"
            )}
          >
            {node.title}
          </span>
        </Link>
      </div>
      {hasChildren && open && (
        <ul>
          {node.children.map((child) => (
            <DocNode
              key={child.id}
              node={child}
              depth={depth + 1}
              activeSlug={activeSlug}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function KnowledgeTree({
  collections,
  nodes,
}: {
  collections: KnowledgeCollection[];
  nodes: KnowledgeTreeNode[];
}) {
  const t = useTranslations("knowledge");
  const pathname = usePathname();
  const activeSlug = useMemo(() => {
    const m = pathname.match(/\/knowledge\/([a-z0-9-]+)/);
    return m?.[1] ?? null;
  }, [pathname]);

  const roots = useMemo(() => buildTree(nodes), [nodes]);

  if (collections.length === 0) {
    return (
      <p className="px-2 py-4 text-sm text-muted-foreground">{t("noDocs")}</p>
    );
  }

  return (
    <nav className="flex flex-col gap-4">
      {collections.map((collection) => {
        const items = roots.get(collection.id) ?? [];
        return (
          <div key={collection.id}>
            <div className="mb-1 flex items-center gap-1.5 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Folder className="size-3.5" />
              <span className="truncate">{collection.name}</span>
            </div>
            {items.length > 0 ? (
              <ul>
                {items.map((item) => (
                  <DocNode
                    key={item.id}
                    node={item}
                    depth={0}
                    activeSlug={activeSlug}
                  />
                ))}
              </ul>
            ) : (
              <p className="px-2 py-1 text-xs text-muted-foreground/70">
                {t("emptyCollection")}
              </p>
            )}
          </div>
        );
      })}
    </nav>
  );
}

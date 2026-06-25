"use client";

import { generateKeyBetween } from "fractional-indexing";
import { ChevronRight, FileText, Folder } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { moveDocument } from "@/actions/knowledge";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import type { KnowledgeCollection, KnowledgeTreeNode } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

type TreeItem = KnowledgeTreeNode & { children: TreeItem[] };

// Assemble the flat (parent, rank)-ordered rows into a nesting tree. Orphans
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

// Ids of `rootId` and everything beneath it — a node can't be dropped onto its
// own subtree (the server guards too, this just blocks the UI affordance).
function subtreeIds(nodes: KnowledgeTreeNode[], rootId: string): Set<string> {
  const childrenOf = new Map<string | null, string[]>();
  for (const n of nodes) {
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n.id);
    childrenOf.set(n.parentId, list);
  }
  const out = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop() as string;
    for (const child of childrenOf.get(id) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
}

// Where a drop lands relative to the hovered row: re-order as a sibling above
// (before) / below (after), or nest as a child (inside). Mirrors the VSCode /
// Notion tree convention — the row's top/bottom edges reorder, its middle nests.
type Zone = "before" | "after" | "inside";
type DropAt = { id: string; zone: Zone };

// Map the pointer's vertical position within a row to a drop zone. The middle
// 40% nests; the outer bands re-order.
function zoneFromEvent(e: React.DragEvent<HTMLElement>): Zone {
  const rect = e.currentTarget.getBoundingClientRect();
  const y = e.clientY - rect.top;
  if (y < rect.height * 0.3) return "before";
  if (y > rect.height * 0.7) return "after";
  return "inside";
}

type DragCtx = {
  draggingId: string | null;
  dropTarget: DropAt | null;
  forbidden: Set<string>;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverNode: (id: string, zone: Zone) => void;
  onDropOnNode: (targetId: string, zone: Zone) => void;
};

function DocNode({
  node,
  depth,
  activeSlug,
  ctx,
}: {
  node: TreeItem;
  depth: number;
  activeSlug: string | null;
  ctx: DragCtx;
}) {
  const hasChildren = node.children.length > 0;
  const isActive = node.slug === activeSlug;
  const [open, setOpen] = useState(true);

  const isDragging = ctx.draggingId === node.id;
  const dropZone = ctx.dropTarget?.id === node.id ? ctx.dropTarget.zone : null;
  const isForbidden = ctx.forbidden.has(node.id);

  return (
    <li>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: row is a native drag-and-drop target; the link inside it carries the semantics */}
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          ctx.onDragStart(node.id);
        }}
        onDragEnd={ctx.onDragEnd}
        onDragOver={(e) => {
          if (ctx.draggingId && !isForbidden) {
            e.preventDefault();
            ctx.onDragOverNode(node.id, zoneFromEvent(e));
          }
        }}
        onDrop={(e) => {
          if (ctx.draggingId && !isForbidden) {
            e.preventDefault();
            e.stopPropagation();
            ctx.onDropOnNode(node.id, zoneFromEvent(e));
          }
        }}
        className={cn(
          "group relative flex items-center gap-1 rounded-md pr-2 text-sm hover:bg-accent",
          isActive && "bg-accent font-medium",
          isDragging && "opacity-40",
          dropZone === "inside" && "ring-2 ring-primary ring-inset"
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {dropZone === "before" && (
          <span className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded-full bg-primary" />
        )}
        {dropZone === "after" && (
          <span className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-primary" />
        )}
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
              ctx={ctx}
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
  const tCommon = useTranslations("common");
  const pathname = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const activeSlug = useMemo(() => {
    const m = pathname.match(/\/knowledge\/([a-z0-9-]+)/);
    return m?.[1] ?? null;
  }, [pathname]);

  const roots = useMemo(() => buildTree(nodes), [nodes]);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropAt | null>(null);
  // Highlight for the collection header drop target (move to that root).
  const [dropCollectionId, setDropCollectionId] = useState<string | null>(null);
  // Collections collapse independently; empty ones start collapsed so they
  // don't clutter the tree with repeated "no documents" rows.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const initial = buildTree(nodes);
    return new Set(
      collections
        .filter((c) => (initial.get(c.id)?.length ?? 0) === 0)
        .map((c) => c.id)
    );
  });
  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Self + descendants of the dragged node — invalid drop destinations.
  const forbidden = useMemo(
    () => (draggingId ? subtreeIds(nodes, draggingId) : new Set<string>()),
    [nodes, draggingId]
  );

  function clearDrag() {
    setDraggingId(null);
    setDropTarget(null);
    setDropCollectionId(null);
  }

  function commitMove(
    documentId: string,
    collectionId: string,
    parentId: string | null,
    rank: string
  ) {
    startTransition(async () => {
      const res = await moveDocument({
        documentId,
        collectionId,
        parentId,
        rank,
      });
      if (!res.success) {
        toast.error(res.message ?? tCommon("errorGeneric"));
        return;
      }
      router.refresh();
    });
  }

  // Rank-ordered siblings under (parentId, collectionId), optionally excluding
  // the node being dragged so its own rank never skews neighbour lookups.
  function siblingsOf(
    parentId: string | null,
    collectionId: string,
    excludeId?: string
  ): KnowledgeTreeNode[] {
    return nodes
      .filter(
        (n) =>
          (n.parentId ?? null) === parentId &&
          n.collectionId === collectionId &&
          n.id !== excludeId
      )
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  }

  // Compute the destination (parent, collection, rank) from the drop zone and
  // commit. The rank is generated strictly between the two neighbours at the
  // drop site, so no sibling is renumbered.
  function dropOnNode(targetId: string, zone: Zone) {
    const dragId = draggingId;
    clearDrag();
    if (!dragId || dragId === targetId) return;
    const target = nodes.find((n) => n.id === targetId);
    if (!target) return;

    let parentId: string | null;
    let prev: string | null;
    let next: string | null;
    if (zone === "inside") {
      parentId = target.id;
      const kids = siblingsOf(target.id, target.collectionId, dragId);
      prev = kids.at(-1)?.rank ?? null; // append as the last child
      next = null;
    } else {
      parentId = target.parentId ?? null;
      const sibs = siblingsOf(parentId, target.collectionId, dragId);
      const idx = sibs.findIndex((n) => n.id === targetId);
      if (zone === "before") {
        prev = sibs[idx - 1]?.rank ?? null;
        next = target.rank;
      } else {
        prev = target.rank;
        next = sibs[idx + 1]?.rank ?? null;
      }
    }

    let rank: string;
    try {
      rank = generateKeyBetween(prev, next);
    } catch {
      return; // ranks collided (shouldn't happen) — skip rather than corrupt
    }
    commitMove(dragId, target.collectionId, parentId, rank);
  }

  function dropOnCollection(collectionId: string) {
    const dragId = draggingId;
    clearDrag();
    if (!dragId) return;
    // Append after the collection's existing top-level docs.
    const roots = siblingsOf(null, collectionId, dragId);
    const rank = generateKeyBetween(roots.at(-1)?.rank ?? null, null);
    commitMove(dragId, collectionId, null, rank);
  }

  const ctx: DragCtx = {
    draggingId,
    dropTarget,
    forbidden,
    onDragStart: setDraggingId,
    onDragEnd: clearDrag,
    onDragOverNode: (id, zone) => {
      setDropTarget({ id, zone });
      setDropCollectionId(null);
    },
    onDropOnNode: dropOnNode,
  };

  if (collections.length === 0) {
    return (
      <p className="px-2 py-4 text-sm text-muted-foreground">{t("noDocs")}</p>
    );
  }

  return (
    <nav className="flex flex-col gap-4">
      {collections.map((collection) => {
        const items = roots.get(collection.id) ?? [];
        const isCollectionDropTarget = dropCollectionId === collection.id;
        const isOpen = !collapsed.has(collection.id);
        return (
          <div key={collection.id}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: collection header is a drop target for moving a doc to the collection root */}
            <div
              onDragOver={(e) => {
                if (draggingId) {
                  e.preventDefault();
                  setDropCollectionId(collection.id);
                  setDropTarget(null);
                }
              }}
              onDrop={(e) => {
                if (draggingId) {
                  e.preventDefault();
                  dropOnCollection(collection.id);
                }
              }}
              className={cn(
                "group/col mb-1 flex items-center gap-1 rounded-md pr-2 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent/60",
                isCollectionDropTarget && "ring-2 ring-primary ring-inset"
              )}
            >
              <button
                type="button"
                onClick={() => toggleCollapsed(collection.id)}
                className="flex flex-1 items-center gap-1.5 py-1 pl-1 text-left"
                aria-expanded={isOpen}
              >
                <ChevronRight
                  className={cn(
                    "size-3 shrink-0 transition-transform",
                    isOpen && "rotate-90"
                  )}
                />
                <Folder className="size-3.5 shrink-0" />
                <span className="truncate">{collection.name}</span>
                {items.length > 0 && (
                  <span className="text-muted-foreground/50 normal-case">
                    {items.length}
                  </span>
                )}
              </button>
            </div>
            {isOpen &&
              (items.length > 0 ? (
                <ul>
                  {items.map((item) => (
                    <DocNode
                      key={item.id}
                      node={item}
                      depth={0}
                      activeSlug={activeSlug}
                      ctx={ctx}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-2 pb-1 pl-7 text-xs text-muted-foreground/60 normal-case">
                  {t("emptyCollection")}
                </p>
              ))}
          </div>
        );
      })}
    </nav>
  );
}

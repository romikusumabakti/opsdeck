"use client";

import { ChevronRight, FileText, Folder } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { moveDocument } from "@/actions/knowledge";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
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

type DragCtx = {
  draggingId: string | null;
  dropTargetId: string | null;
  forbidden: Set<string>;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverNode: (id: string) => void;
  onDropOnNode: (targetId: string) => void;
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
  const isDropTarget = ctx.dropTargetId === node.id;
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
            ctx.onDragOverNode(node.id);
          }
        }}
        onDrop={(e) => {
          if (ctx.draggingId && !isForbidden) {
            e.preventDefault();
            e.stopPropagation();
            ctx.onDropOnNode(node.id);
          }
        }}
        className={cn(
          "group flex items-center gap-1 rounded-md pr-2 text-sm hover:bg-accent",
          isActive && "bg-accent font-medium",
          isDragging && "opacity-40",
          isDropTarget && "ring-2 ring-primary ring-inset"
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
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // Self + descendants of the dragged node — invalid drop destinations.
  const forbidden = useMemo(
    () => (draggingId ? subtreeIds(nodes, draggingId) : new Set<string>()),
    [nodes, draggingId]
  );

  function commitMove(
    documentId: string,
    collectionId: string,
    parentId: string | null,
    position: number
  ) {
    startTransition(async () => {
      const res = await moveDocument({
        documentId,
        collectionId,
        parentId,
        position,
      });
      if (!res.success) {
        toast.error(res.message ?? tCommon("errorGeneric"));
        return;
      }
      router.refresh();
    });
  }

  function dropOnNode(targetId: string) {
    const dragId = draggingId;
    setDraggingId(null);
    setDropTargetId(null);
    if (!dragId || dragId === targetId) return;
    const target = nodes.find((n) => n.id === targetId);
    if (!target) return;
    // Nest the dragged node as the last child of the target.
    const siblings = nodes.filter((n) => n.parentId === targetId);
    const position = siblings.reduce((m, n) => Math.max(m, n.position + 1), 0);
    commitMove(dragId, target.collectionId, targetId, position);
  }

  function dropOnCollection(collectionId: string) {
    const dragId = draggingId;
    setDraggingId(null);
    setDropTargetId(null);
    if (!dragId) return;
    // Move to the collection root, appended after existing top-level docs.
    const rootDocs = nodes.filter(
      (n) => n.collectionId === collectionId && n.parentId === null
    );
    const position = rootDocs.reduce((m, n) => Math.max(m, n.position + 1), 0);
    commitMove(dragId, collectionId, null, position);
  }

  const ctx: DragCtx = {
    draggingId,
    dropTargetId,
    forbidden,
    onDragStart: setDraggingId,
    onDragEnd: () => {
      setDraggingId(null);
      setDropTargetId(null);
    },
    onDragOverNode: setDropTargetId,
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
        const isCollectionDropTarget = dropTargetId === `c:${collection.id}`;
        return (
          <div key={collection.id}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: collection header is a drop target for moving a doc to the collection root */}
            <div
              onDragOver={(e) => {
                if (draggingId) {
                  e.preventDefault();
                  setDropTargetId(`c:${collection.id}`);
                }
              }}
              onDrop={(e) => {
                if (draggingId) {
                  e.preventDefault();
                  dropOnCollection(collection.id);
                }
              }}
              className={cn(
                "mb-1 flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground",
                isCollectionDropTarget && "ring-2 ring-primary ring-inset"
              )}
            >
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
                    ctx={ctx}
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

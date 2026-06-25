-- Knowledge ordering migrated from integer "position" to a fractional-index
-- "rank" string. The column is C-collated so plain byte ordering matches the
-- rank alphabet (digits < uppercase < lowercase) that fractional-indexing
-- assumes; under a locale collation mixed-case keys would sort wrongly.
ALTER TABLE "knowledge_collections" ADD COLUMN "rank" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "rank" text COLLATE "C";--> statement-breakpoint

-- Backfill: per sibling group, assign ascending fractional-indexing-valid keys
-- (a0..az, then b00..) in the existing position order, preserving current tree
-- order. Keys mirror generateKeyBetween's append sequence so later inserts work.
UPDATE "knowledge_collections" c SET "rank" = (
  SELECT CASE
    WHEN rn < 62 THEN 'a' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', rn::int + 1, 1)
    ELSE 'b'
      || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((rn - 62) / 62)::int + 1, 1)
      || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((rn - 62) % 62)::int + 1, 1)
  END
  FROM (
    SELECT id, row_number() OVER (ORDER BY position, name, id) - 1 AS rn
    FROM "knowledge_collections"
  ) o WHERE o.id = c.id
);--> statement-breakpoint

UPDATE "knowledge_documents" d SET "rank" = (
  SELECT CASE
    WHEN rn < 62 THEN 'a' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', rn::int + 1, 1)
    ELSE 'b'
      || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((rn - 62) / 62)::int + 1, 1)
      || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ((rn - 62) % 62)::int + 1, 1)
  END
  FROM (
    SELECT id, row_number() OVER (PARTITION BY collection_id, parent_id ORDER BY position, title, id) - 1 AS rn
    FROM "knowledge_documents"
  ) o WHERE o.id = d.id
);--> statement-breakpoint

ALTER TABLE "knowledge_collections" ALTER COLUMN "rank" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ALTER COLUMN "rank" SET NOT NULL;--> statement-breakpoint
DROP INDEX "knowledge_documents_tree_idx";--> statement-breakpoint
CREATE INDEX "knowledge_documents_tree_idx" ON "knowledge_documents" ("collection_id","parent_id","rank");

SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "project_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"rank" text COLLATE "C" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "group_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "project_groups_name_unique_idx" ON "project_groups" (lower(trim("name")));--> statement-breakpoint
CREATE INDEX "projects_group_idx" ON "projects" ("group_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "project_groups"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Backfill: one group per distinct non-empty trim(client), compared ignoring
-- case. The name is the most frequent spelling (ties: alphabetical, byte
-- order). Ranks follow the group names alphabetically, spelled as
-- fractional-indexing's generateKeyBetween would for an appended sequence:
-- a0..az for the first 62, then b00..bzz. Idempotent: groups whose key already
-- exists are not inserted again, and only ungrouped projects are linked.
-- Rank assumptions: the table is new, so the backfill seeds every rank (a
-- re-run that inserts more groups restarts at a0 and may repeat ranks, which
-- only ties their order); the two-character spelling covers at most 3906
-- groups (62 + 62*62), far above any real count of distinct client values.
INSERT INTO "project_groups" ("name", "rank")
SELECT p."name",
  CASE WHEN p."n" < 62
    THEN 'a' || substr(c."chars", p."n" + 1, 1)
    ELSE 'b' || substr(c."chars", (p."n" - 62) / 62 + 1, 1)
             || substr(c."chars", (p."n" - 62) % 62 + 1, 1)
  END
FROM (
  SELECT "name", (row_number() OVER (ORDER BY lower("name") COLLATE "C", "name" COLLATE "C") - 1)::int AS "n"
  FROM (
    SELECT DISTINCT ON (s."key") s."name"
    FROM (
      SELECT lower(trim("client")) AS "key", trim("client") AS "name", count(*) AS "uses"
      FROM "projects"
      WHERE trim("client") <> ''
      GROUP BY lower(trim("client")), trim("client")
    ) s
    ORDER BY s."key", s."uses" DESC, s."name" COLLATE "C"
  ) picked
  WHERE NOT EXISTS (
    SELECT 1 FROM "project_groups" g WHERE lower(trim(g."name")) = lower(picked."name")
  )
) p
CROSS JOIN (SELECT '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' AS "chars") c;--> statement-breakpoint
UPDATE "projects" SET "group_id" = g."id"
FROM "project_groups" g
WHERE "projects"."group_id" IS NULL
  AND trim("projects"."client") <> ''
  AND lower(trim(g."name")) = lower(trim("projects"."client"));

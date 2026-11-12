SET LOCAL lock_timeout = '5s';--> statement-breakpoint
UPDATE "users" AS u SET "role" = CASE
    WHEN EXISTS (SELECT 1 FROM "project_members" m WHERE m."user_id" = u."id" AND m."role" IN ('qa', 'viewer')) THEN 'qa'
    WHEN EXISTS (SELECT 1 FROM "project_members" m WHERE m."user_id" = u."id" AND m."role" = 'engineer') THEN 'engineer'
    ELSE 'qa'
  END
WHERE u."role" NOT IN ('admin', 'infra', 'observer')
   OR (u."role" = 'observer' AND EXISTS (SELECT 1 FROM "project_members" m WHERE m."user_id" = u."id" AND m."role" IN ('qa', 'engineer')));--> statement-breakpoint
UPDATE "invitations" SET "role" = 'qa' WHERE "role" NOT IN ('admin', 'infra', 'engineer', 'qa', 'observer');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'qa';--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "role" SET DEFAULT 'qa';--> statement-breakpoint
ALTER TABLE "project_members" ALTER COLUMN "role" SET DEFAULT 'qa';

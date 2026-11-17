SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "assistant_drafts" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN "project_name" text;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_drafts" ADD CONSTRAINT "assistant_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
UPDATE "assistant_messages" AS m SET
	"project_id" = c."project_id",
	"project_name" = p."name"
FROM "assistant_conversations" AS c
JOIN "projects" AS p ON p."id" = c."project_id"
WHERE m."conversation_id" = c."id" AND m."role" = 'user' AND m."project_id" IS NULL AND m."project_name" IS NULL;--> statement-breakpoint
UPDATE "assistant_drafts" AS d SET
	"project_id" = c."project_id"
FROM "assistant_conversations" AS c
WHERE d."conversation_id" = c."id" AND d."project_id" IS NULL AND c."project_id" IS NOT NULL;

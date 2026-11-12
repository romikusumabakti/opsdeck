SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "project_apps" (
	"project_id" uuid,
	"app_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_apps_project_id_app_id_pk" PRIMARY KEY("project_id","app_id")
);
--> statement-breakpoint
CREATE TABLE "project_component_branches" (
	"project_id" uuid,
	"component_key" text,
	"branch" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "project_component_branches_project_id_component_key_pk" PRIMARY KEY("project_id","component_key")
);
--> statement-breakpoint
CREATE INDEX "project_apps_app_idx" ON "project_apps" ("app_id");--> statement-breakpoint
CREATE INDEX "project_component_branches_component_idx" ON "project_component_branches" ("component_key");--> statement-breakpoint
CREATE INDEX "project_component_branches_updated_by_idx" ON "project_component_branches" ("updated_by");--> statement-breakpoint
ALTER TABLE "project_apps" ADD CONSTRAINT "project_apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_apps" ADD CONSTRAINT "project_apps_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "project_component_branches" ADD CONSTRAINT "project_component_branches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_component_branches" ADD CONSTRAINT "project_component_branches_component_key_fk" FOREIGN KEY ("component_key") REFERENCES "app_components"("component_key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "project_component_branches" ADD CONSTRAINT "project_component_branches_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
INSERT INTO "project_apps" ("project_id", "app_id")
  SELECT DISTINCT "project_id", "app_id" FROM "environments" WHERE "app_id" IS NOT NULL
  UNION
  SELECT DISTINCT e."project_id", c."app_id" FROM "deploy_targets" t
    JOIN "environments" e ON e."id" = t."environment_id"
    JOIN "app_components" c ON c."component_key" = t."component_key"
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "project_component_branches" ("project_id", "component_key", "branch")
  SELECT DISTINCT ON ("project_id", "component_key") "project_id", "component_key", "source_branch"
  FROM (SELECT e."project_id", t."component_key", t."source_branch",
               count(*) AS n, max(e."id"::text) AS newest
        FROM "deploy_targets" t JOIN "environments" e ON e."id" = t."environment_id"
        GROUP BY 1, 2, 3) s
  ORDER BY "project_id", "component_key", n DESC, newest DESC
ON CONFLICT DO NOTHING;

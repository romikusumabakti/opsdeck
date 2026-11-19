SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "project_services" (
	"project_id" uuid,
	"component_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_services_project_id_component_key_pk" PRIMARY KEY("project_id","component_key")
);
--> statement-breakpoint
CREATE TABLE "service_variable_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"component_key" text NOT NULL,
	"name" text NOT NULL,
	"kind" "variable_kind" NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"default_value" text,
	"generated_length" integer,
	"escrow" boolean DEFAULT false NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "service_variable_templates_generated_length_check" CHECK ("generated_length" >= 16 AND "generated_length" <= 128)
);
--> statement-breakpoint
ALTER TABLE "app_components" ALTER COLUMN "app_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "project_services_component_idx" ON "project_services" ("component_key");--> statement-breakpoint
CREATE UNIQUE INDEX "service_variable_templates_component_name_idx" ON "service_variable_templates" ("component_key","name");--> statement-breakpoint
ALTER TABLE "project_services" ADD CONSTRAINT "project_services_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_services" ADD CONSTRAINT "project_services_component_key_fk" FOREIGN KEY ("component_key") REFERENCES "app_components"("component_key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "service_variable_templates" ADD CONSTRAINT "service_variable_templates_component_key_fkey" FOREIGN KEY ("component_key") REFERENCES "app_components"("component_key") ON DELETE CASCADE;--> statement-breakpoint
-- A project's services: every component of its linked apps, of the apps its
-- environments name (the previous release may have left one without a
-- project_apps row), and every component its deploy targets deploy.
INSERT INTO "project_services" ("project_id", "component_key")
  SELECT pa."project_id", c."component_key" FROM "project_apps" pa
    JOIN "app_components" c ON c."app_id" = pa."app_id"
  UNION
  SELECT e."project_id", c."component_key" FROM "environments" e
    JOIN "app_components" c ON c."app_id" = e."app_id"
  UNION
  SELECT e."project_id", t."component_key" FROM "deploy_targets" t
    JOIN "environments" e ON e."id" = t."environment_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Each app template, copied to every component of its app.
INSERT INTO "service_variable_templates"
  ("component_key", "name", "kind", "required", "default_value",
   "generated_length", "escrow", "description", "created_at", "updated_at")
  SELECT c."component_key", t."name", t."kind", t."required", t."default_value",
         t."generated_length", t."escrow", t."description", t."created_at", t."updated_at"
  FROM "app_variable_templates" t
    JOIN "app_components" c ON c."app_id" = t."app_id"
ON CONFLICT DO NOTHING;

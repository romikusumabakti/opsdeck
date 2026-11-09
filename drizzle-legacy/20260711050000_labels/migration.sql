-- Workspace-wide issue labels + many-to-many join. Seeds a default taxonomy.
-- Additive.
BEGIN;

CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#64748b' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "labels_name_unique" UNIQUE("name")
);

CREATE TABLE "issue_labels" (
	"issue_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "issue_labels_issue_id_label_id_pk" PRIMARY KEY("issue_id", "label_id"),
	CONSTRAINT "issue_labels_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE cascade,
	CONSTRAINT "issue_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "labels"("id") ON DELETE cascade
);

CREATE INDEX "issue_labels_label_idx" ON "issue_labels" ("label_id");

-- Default taxonomy.
INSERT INTO "labels" ("name", "color") VALUES
	('bug', '#ef4444'),
	('feature', '#3b82f6'),
	('enhancement', '#22c55e'),
	('question', '#a855f7'),
	('blocked', '#f97316'),
	('duplicate', '#94a3b8');

COMMIT;

CREATE TABLE "s3_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"endpoint" text NOT NULL,
	"region" text DEFAULT 'us-east-1' NOT NULL,
	"bucket" text NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_key" text NOT NULL,
	"force_path_style" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

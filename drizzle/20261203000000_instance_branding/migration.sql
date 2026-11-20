SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "instance_brand_logos" (
	"theme" text PRIMARY KEY,
	"bytes" bytea NOT NULL,
	"content_type" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_brand_logos_theme_check" CHECK ("theme" in ('light', 'dark')),
	CONSTRAINT "instance_brand_logos_content_type_check" CHECK ("content_type" in ('image/svg+xml', 'image/png', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "brand_name" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "brand_company" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "brand_accent" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "brand_updated_at" timestamp with time zone;
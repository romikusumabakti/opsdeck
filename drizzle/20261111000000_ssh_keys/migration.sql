SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TYPE "server_auth" AS ENUM('password', 'key');--> statement-breakpoint
CREATE TYPE "ssh_key_status" AS ENUM('current', 'previous', 'retired');--> statement-breakpoint
CREATE TABLE "ssh_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" "ssh_key_status" DEFAULT 'current'::"ssh_key_status" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "auth" "server_auth" DEFAULT 'password'::"server_auth" NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "host_key_type" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "host_key" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "host_key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "host_key_pinned_at" timestamp;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "host_key_offered_fingerprint" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "ssh_key_id" uuid;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "ssh_from" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "key_error" text;--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "password" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_one_current_idx" ON "ssh_keys" ("status") WHERE status = 'current';--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_ssh_key_id_ssh_keys_id_fkey" FOREIGN KEY ("ssh_key_id") REFERENCES "ssh_keys"("id") ON DELETE SET NULL;
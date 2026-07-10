-- Add optional purpose + owner to environments so the 1..N deployments of a
-- project can be labelled by why they exist (a QA's copy, a frontend dev's, a
-- devops sandbox) instead of an opaque host suffix. Additive + nullable — no
-- backfill required, existing rows keep NULL.
BEGIN;

CREATE TYPE "public"."environment_kind" AS ENUM('qa', 'dev', 'release', 'sandbox', 'prod');

ALTER TABLE "environments" ADD COLUMN "kind" "environment_kind";
ALTER TABLE "environments" ADD COLUMN "owner" text;

COMMIT;

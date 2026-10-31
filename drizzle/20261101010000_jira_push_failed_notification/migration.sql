-- In-app notification when an OpsDeck edit can't be pushed to Jira (conflict,
-- no workflow transition, or no matching priority). Additive: the running build
-- never writes this value, so this can be applied before the deploy.
-- ALTER TYPE ... ADD VALUE can run inside a transaction on PostgreSQL 12+, as
-- long as the new value isn't used in the same transaction.
BEGIN;

ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'jira_push_failed';

COMMIT;

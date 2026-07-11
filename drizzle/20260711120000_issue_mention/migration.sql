-- Fase 5 (@mention): a new notification type for comment mentions. ADD VALUE is
-- additive and idempotent-guarded; run outside a transaction so the new label is
-- usable immediately (Postgres restricts using a value added in the same tx).
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'issue_mention';

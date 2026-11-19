SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TYPE "teardown_step_kind" ADD VALUE 'drop_assistant_db_login' BEFORE 'remove_tunnel_route';

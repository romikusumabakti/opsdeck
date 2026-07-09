ALTER TYPE "task_status" RENAME TO "run_status";--> statement-breakpoint
ALTER TABLE "tasks" RENAME TO "runs";--> statement-breakpoint
ALTER INDEX "tasks_project_run_idx" RENAME TO "runs_project_run_idx";--> statement-breakpoint
ALTER INDEX "tasks_status_idx" RENAME TO "runs_status_idx";
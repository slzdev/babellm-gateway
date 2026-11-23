ALTER TABLE "catalog_models" ADD COLUMN "cache_write_per_mtok" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "cache_write_tokens" integer;
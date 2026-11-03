CREATE TYPE "public"."decisions_api_flavor" AS ENUM('openai');--> statement-breakpoint
ALTER TABLE "catalog_models" ADD COLUMN "decisions_api_flavor" "decisions_api_flavor";--> statement-breakpoint
ALTER TABLE "catalog_models" ADD COLUMN "decisions_path" text;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "decisions_api_flavor" "decisions_api_flavor" DEFAULT 'openai' NOT NULL;
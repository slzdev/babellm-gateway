ALTER TYPE "public"."api_flavor" ADD VALUE 'anthropic_messages';--> statement-breakpoint
ALTER TABLE "catalog_models" ADD COLUMN "messages_path" text;
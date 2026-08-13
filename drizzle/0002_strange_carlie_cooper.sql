CREATE TYPE "public"."api_flavor" AS ENUM('chat_completions', 'responses');--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "api_flavor" "api_flavor" DEFAULT 'chat_completions' NOT NULL;
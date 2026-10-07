CREATE TYPE "public"."decisions_api_flavor" AS ENUM('openai');--> statement-breakpoint
-- 0014's mistaken Decisions sentinel has no recoverable prior chat value.
-- Cast to text first: fresh migrations add that enum value in this transaction.
ALTER TABLE "providers" ALTER COLUMN "api_flavor" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "catalog_models" ALTER COLUMN "api_flavor" SET DATA TYPE text USING "api_flavor"::text;--> statement-breakpoint
ALTER TABLE "providers" ALTER COLUMN "api_flavor" SET DATA TYPE text USING "api_flavor"::text;--> statement-breakpoint
UPDATE "providers" SET "api_flavor" = 'chat_completions' WHERE "api_flavor" = 'decisions';--> statement-breakpoint
UPDATE "catalog_models" SET "api_flavor" = NULL WHERE "api_flavor" = 'decisions';--> statement-breakpoint
DROP TYPE "public"."api_flavor";--> statement-breakpoint
CREATE TYPE "public"."api_flavor" AS ENUM('chat_completions', 'responses', 'anthropic_messages');--> statement-breakpoint
ALTER TABLE "catalog_models" ALTER COLUMN "api_flavor" SET DATA TYPE "public"."api_flavor" USING "api_flavor"::"public"."api_flavor";--> statement-breakpoint
ALTER TABLE "providers" ALTER COLUMN "api_flavor" SET DATA TYPE "public"."api_flavor" USING "api_flavor"::"public"."api_flavor";--> statement-breakpoint
ALTER TABLE "providers" ALTER COLUMN "api_flavor" SET DEFAULT 'chat_completions'::"public"."api_flavor";--> statement-breakpoint
ALTER TABLE "catalog_models" ADD COLUMN "decisions_api_flavor" "decisions_api_flavor";--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "decisions_api_flavor" "decisions_api_flavor" DEFAULT 'openai' NOT NULL;

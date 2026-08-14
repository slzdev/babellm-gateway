CREATE TYPE "public"."status_class" AS ENUM('success', 'client_error', 'server_error');--> statement-breakpoint
CREATE TABLE "usage_rollups" (
	"bucket" timestamp with time zone NOT NULL,
	"api_key_id" uuid,
	"key_name" text,
	"user_id" uuid,
	"user_name" text,
	"model" varchar(128),
	"provider" text,
	"status_class" "status_class" NOT NULL,
	"requests" integer NOT NULL,
	"unpriced_requests" integer NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"cached_tokens" bigint NOT NULL,
	"reasoning_tokens" bigint NOT NULL,
	"input_cost_usd" numeric(18, 9) NOT NULL,
	"cached_cost_usd" numeric(18, 9) NOT NULL,
	"output_cost_usd" numeric(18, 9) NOT NULL,
	"cost_usd" numeric(18, 9) NOT NULL,
	"latency_sum_ms" bigint NOT NULL,
	"latency_max_ms" integer NOT NULL,
	"latency_count" integer NOT NULL,
	"ttft_sum_ms" bigint NOT NULL,
	"ttft_count" integer NOT NULL,
	CONSTRAINT "usage_rollups_grain_key" UNIQUE NULLS NOT DISTINCT("bucket","api_key_id","user_id","model","provider","status_class")
);
--> statement-breakpoint
CREATE INDEX "usage_rollups_bucket_idx" ON "usage_rollups" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "usage_rollups_key_bucket_idx" ON "usage_rollups" USING btree ("api_key_id","bucket");--> statement-breakpoint
CREATE INDEX "usage_rollups_user_bucket_idx" ON "usage_rollups" USING btree ("user_id","bucket");--> statement-breakpoint
CREATE INDEX "usage_rollups_model_bucket_idx" ON "usage_rollups" USING btree ("model","bucket");
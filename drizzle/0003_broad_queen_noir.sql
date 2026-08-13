CREATE TYPE "public"."request_outcome" AS ENUM('ok', 'error', 'client_closed', 'stream_interrupted');--> statement-breakpoint
-- Partitioned by month on the v7 primary key. Postgres compares uuid
-- byte-wise and v7 leads with a big-endian millisecond timestamp, so uuid
-- order is time order and a month boundary is a plain uuid bound.
-- Partitioning on id rather than created_at is what keeps the primary key a
-- bare (id): a partitioned table requires the partition key in every unique
-- constraint.
--
-- No partitions are created here and there is deliberately no DEFAULT
-- partition. src/lib/logs/partitions.ts owns the month arithmetic, so it has
-- exactly one implementation and it is not duplicated in SQL.
CREATE TABLE "request_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"api_key_id" uuid,
	"key_name" text,
	"model" varchar(128),
	"stream" boolean DEFAULT false NOT NULL,
	"status" integer NOT NULL,
	"outcome" "request_outcome" NOT NULL,
	"error_type" text,
	"error_code" text,
	"error_message" text,
	"latency_ms" integer NOT NULL,
	"ttft_ms" integer,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_target_id" uuid,
	"final_provider_id" uuid,
	"final_provider" text,
	"final_upstream_model" varchar(128),
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cached_tokens" integer,
	"reasoning_tokens" integer,
	"input_cost_usd" numeric(18, 9),
	"cached_cost_usd" numeric(18, 9),
	"output_cost_usd" numeric(18, 9),
	"cost_usd" numeric(18, 9),
	"pricing" jsonb,
	"dropped_params" jsonb,
	"payload_captured" boolean DEFAULT false NOT NULL,
	"request_json" jsonb,
	"response_json" jsonb,
	"payload_truncated" boolean DEFAULT false NOT NULL
) PARTITION BY RANGE ("id");
--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_logs_api_key_idx" ON "request_logs" USING btree ("api_key_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "request_logs_model_idx" ON "request_logs" USING btree ("model","id" DESC NULLS LAST);
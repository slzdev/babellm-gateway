CREATE TYPE "public"."request_outcome" AS ENUM('ok', 'error', 'client_closed', 'stream_interrupted');--> statement-breakpoint
CREATE TABLE "request_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
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
	"payload_captured" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_payloads" (
	"request_log_id" uuid PRIMARY KEY NOT NULL,
	"request_json" jsonb,
	"response_json" jsonb,
	"truncated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_payloads" ADD CONSTRAINT "request_payloads_request_log_id_request_logs_id_fk" FOREIGN KEY ("request_log_id") REFERENCES "public"."request_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "request_logs_request_id_idx" ON "request_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "request_logs_api_key_idx" ON "request_logs" USING btree ("api_key_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "request_logs_model_idx" ON "request_logs" USING btree ("model","id" DESC NULLS LAST);
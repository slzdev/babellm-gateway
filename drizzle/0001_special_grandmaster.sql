CREATE TYPE "public"."catalog_origin" AS ENUM('discovered', 'manual');--> statement-breakpoint
CREATE TYPE "public"."catalog_status" AS ENUM('available', 'missing');--> statement-breakpoint
CREATE TYPE "public"."model_kind" AS ENUM('chat', 'embedding', 'image', 'audio', 'video', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('ok', 'failed', 'unsupported');--> statement-breakpoint
CREATE TABLE "catalog_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"canonical_key" text,
	"origin" "catalog_origin" DEFAULT 'discovered' NOT NULL,
	"status" "catalog_status" DEFAULT 'available' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"discovered" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"registry" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"override" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kind" "model_kind" DEFAULT 'unknown' NOT NULL,
	"context_window" integer,
	"max_output_tokens" integer,
	"input_per_mtok" numeric(12, 6),
	"output_per_mtok" numeric(12, 6),
	"cached_input_per_mtok" numeric(12, 6),
	"supports_tools" boolean,
	"supports_streaming" boolean,
	"modalities" jsonb,
	"sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_cache" (
	"url" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"etag" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "last_sync_status" "sync_status";--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "last_sync_summary" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_models" ADD CONSTRAINT "catalog_models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_models_provider_model_idx" ON "catalog_models" USING btree ("provider_id","model_id");--> statement-breakpoint
CREATE INDEX "catalog_models_kind_idx" ON "catalog_models" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "catalog_models_canonical_key_idx" ON "catalog_models" USING btree ("canonical_key");
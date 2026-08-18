ALTER TABLE "catalog_models" ADD COLUMN "force_upstream_stream" boolean;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "force_upstream_stream" boolean DEFAULT false NOT NULL;
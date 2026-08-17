ALTER TABLE "route_targets" ADD COLUMN "breaker_threshold" integer;--> statement-breakpoint
ALTER TABLE "route_targets" ADD COLUMN "breaker_cooldown_seconds" integer;
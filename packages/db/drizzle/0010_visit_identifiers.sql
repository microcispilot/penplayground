ALTER TABLE "site_visits" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "site_visits" ADD COLUMN "screen_width" integer;--> statement-breakpoint
ALTER TABLE "site_visits" ADD COLUMN "screen_height" integer;--> statement-breakpoint
ALTER TABLE "site_visits" ADD COLUMN "viewport_width" integer;--> statement-breakpoint
ALTER TABLE "site_visits" ADD COLUMN "viewport_height" integer;--> statement-breakpoint
ALTER TABLE "site_visits" ADD COLUMN "device_pixel_ratio" double precision;--> statement-breakpoint
ALTER TABLE "site_visits" ADD COLUMN "ip_address" text;--> statement-breakpoint
CREATE INDEX "site_visits_identifier_idx" ON "site_visits" USING btree ("started_at") WHERE "site_visits"."ip_address" is not null or "site_visits"."user_agent" is not null;
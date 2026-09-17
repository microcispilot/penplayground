ALTER TABLE "participants" ADD COLUMN "google_sub" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "avatar_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX "participants_google_sub_idx" ON "participants" USING btree ("google_sub");
ALTER TABLE "sessions" ADD COLUMN "canonical_id" text;--> statement-breakpoint
CREATE INDEX "sessions_canonical_idx" ON "sessions" USING btree ("canonical_id","started_at");
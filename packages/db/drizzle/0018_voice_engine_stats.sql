ALTER TABLE "session_stats" ADD COLUMN "voice_engine" text;--> statement-breakpoint
ALTER TABLE "session_stats" ADD COLUMN "voice_tts" text;--> statement-breakpoint
CREATE INDEX "session_stats_voice_idx" ON "session_stats" USING btree ("voice_engine","started_at");
CREATE TABLE "plan_events" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"at" bigint NOT NULL,
	"from_plan" text,
	"to_plan" text NOT NULL,
	"interval" text,
	"status" text,
	"source" text DEFAULT 'stripe' NOT NULL,
	"amount_cents" integer,
	"currency" text
);
--> statement-breakpoint
CREATE TABLE "session_engagement" (
	"session_id" text PRIMARY KEY NOT NULL,
	"replays" integer DEFAULT 0 NOT NULL,
	"shares" integer DEFAULT 0 NOT NULL,
	"downloads" integer DEFAULT 0 NOT NULL,
	"exports" integer DEFAULT 0 NOT NULL,
	"last_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_error_stats" (
	"session_id" text NOT NULL,
	"code" text NOT NULL,
	"stage" text,
	"n" integer DEFAULT 0 NOT NULL,
	"first_at_ms" integer DEFAULT 0 NOT NULL,
	"last_at_ms" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "session_error_stats_session_id_code_pk" PRIMARY KEY("session_id","code")
);
--> statement-breakpoint
CREATE TABLE "session_reuse_links" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"source_session_id" text,
	"kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"canonical_id" text,
	"uses" integer DEFAULT 1 NOT NULL,
	"saved_usd" double precision DEFAULT 0 NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_stage_stats" (
	"session_id" text NOT NULL,
	"stage" text NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"ok" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"reused" integer DEFAULT 0 NOT NULL,
	"total_ms" bigint DEFAULT 0 NOT NULL,
	"p50_ms" integer,
	"p95_ms" integer,
	"max_ms" integer,
	"usd" double precision DEFAULT 0 NOT NULL,
	"saved_usd" double precision DEFAULT 0 NOT NULL,
	"first_at_ms" integer DEFAULT 0 NOT NULL,
	"last_at_ms" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "session_stage_stats_session_id_stage_pk" PRIMARY KEY("session_id","stage")
);
--> statement-breakpoint
CREATE TABLE "session_stats" (
	"session_id" text PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"derived_at" bigint NOT NULL,
	"ledger_entries" integer DEFAULT 0 NOT NULL,
	"host_id" text NOT NULL,
	"plan" text NOT NULL,
	"expert_id" text NOT NULL,
	"language" text NOT NULL,
	"band" text NOT NULL,
	"domain" text NOT NULL,
	"canonical_id" text,
	"scope_key" text,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"segments_planned" integer DEFAULT 0 NOT NULL,
	"segments_reached" integer DEFAULT 0 NOT NULL,
	"says" integer DEFAULT 0 NOT NULL,
	"questions" integer DEFAULT 0 NOT NULL,
	"interrupts" integer DEFAULT 0 NOT NULL,
	"ads_shown" integer DEFAULT 0 NOT NULL,
	"ads_skipped" integer DEFAULT 0 NOT NULL,
	"participants" integer DEFAULT 0 NOT NULL,
	"interactions" integer DEFAULT 0 NOT NULL,
	"stages" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"leave_reason" text DEFAULT 'unknown' NOT NULL,
	"progress" double precision DEFAULT 0 NOT NULL,
	"left_at_ms" integer DEFAULT 0 NOT NULL,
	"last_stage" text,
	"last_interaction" text,
	"ad_playing_at_end" boolean DEFAULT false NOT NULL,
	"last_error_code" text,
	"time_to_first_audio_ms" integer,
	"turn_p50_ms" integer,
	"turn_p95_ms" integer,
	"llm_first_token_p50_ms" integer,
	"llm_first_token_p95_ms" integer,
	"tts_first_chunk_p50_ms" integer,
	"tts_first_chunk_p95_ms" integer,
	"stt_final_p50_ms" integer,
	"stt_final_p95_ms" integer,
	"barge_in_p50_ms" integer,
	"barge_in_p95_ms" integer,
	"total_usd" double precision DEFAULT 0 NOT NULL,
	"revenue_usd" double precision DEFAULT 0 NOT NULL,
	"llm_usd" double precision DEFAULT 0 NOT NULL,
	"intent_usd" double precision DEFAULT 0 NOT NULL,
	"image_usd" double precision DEFAULT 0 NOT NULL,
	"tts_usd" double precision DEFAULT 0 NOT NULL,
	"stt_usd" double precision DEFAULT 0 NOT NULL,
	"search_usd" double precision DEFAULT 0 NOT NULL,
	"onten_usd" double precision DEFAULT 0 NOT NULL,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"intent_calls" integer DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_cached" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"tts_bytes" bigint DEFAULT 0 NOT NULL,
	"stt_seconds" double precision DEFAULT 0 NOT NULL,
	"search_requests" integer DEFAULT 0 NOT NULL,
	"pack_hit" boolean DEFAULT false NOT NULL,
	"intake_cache_hit" boolean DEFAULT false NOT NULL,
	"memo_segments_reused" integer DEFAULT 0 NOT NULL,
	"memo_segments_generated" integer DEFAULT 0 NOT NULL,
	"context_speculation_hits" integer DEFAULT 0 NOT NULL,
	"tts_sentences_reused" integer DEFAULT 0 NOT NULL,
	"tts_sentences_generated" integer DEFAULT 0 NOT NULL,
	"image_reused" boolean DEFAULT false NOT NULL,
	"card_reused" boolean DEFAULT false NOT NULL,
	"saved_usd" double precision DEFAULT 0 NOT NULL,
	"fresh_equivalent_usd" double precision DEFAULT 0 NOT NULL,
	"host_opted_out" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_visit_screens" (
	"visit_id" text NOT NULL,
	"screen" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"active_ms" integer DEFAULT 0 NOT NULL,
	"started_at" bigint NOT NULL,
	CONSTRAINT "site_visit_screens_visit_id_screen_pk" PRIMARY KEY("visit_id","screen")
);
--> statement-breakpoint
CREATE TABLE "site_visits" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text,
	"signed_in" boolean DEFAULT false NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"started_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"ended_at" bigint,
	"active_ms" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"beacons" integer DEFAULT 0 NOT NULL,
	"entry_screen" text,
	"last_screen" text,
	"referrer_host" text,
	"campaign_source" text,
	"campaign_medium" text,
	"campaign_name" text,
	"device_type" text DEFAULT 'unknown' NOT NULL,
	"os" text,
	"browser" text,
	"browser_major" smallint,
	"country" text,
	"region" text,
	"city" text,
	"geo_source" text DEFAULT 'none' NOT NULL,
	"timezone" text,
	"utc_offset_minutes" smallint,
	"language" text,
	"sessions_started" integer DEFAULT 0 NOT NULL,
	"sessions_joined" integer DEFAULT 0 NOT NULL,
	"replays_started" integer DEFAULT 0 NOT NULL,
	"shares_copied" integer DEFAULT 0 NOT NULL,
	"downloads_requested" integer DEFAULT 0 NOT NULL,
	"exports_requested" integer DEFAULT 0 NOT NULL,
	"sign_ins_completed" integer DEFAULT 0 NOT NULL,
	"checkouts_started" integer DEFAULT 0 NOT NULL,
	"saves" integer DEFAULT 0 NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"privacy_opened" integer DEFAULT 0 NOT NULL,
	"last_session_id" text
);
--> statement-breakpoint
CREATE TABLE "stats_work_origin" (
	"kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"session_id" text NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "stats_work_origin_kind_scope_key_pk" PRIMARY KEY("kind","scope_key")
);
--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "plan_interval" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "plan_status" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "plan_since" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "plan_events_at_idx" ON "plan_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "plan_events_participant_idx" ON "plan_events" USING btree ("participant_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_events_dedupe_idx" ON "plan_events" USING btree ("participant_id","at","to_plan");--> statement-breakpoint
CREATE INDEX "session_engagement_last_idx" ON "session_engagement" USING btree ("last_at");--> statement-breakpoint
CREATE INDEX "session_error_stats_code_idx" ON "session_error_stats" USING btree ("code");--> statement-breakpoint
CREATE INDEX "session_reuse_links_source_idx" ON "session_reuse_links" USING btree ("source_session_id","at");--> statement-breakpoint
CREATE INDEX "session_reuse_links_session_idx" ON "session_reuse_links" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_reuse_links_scope_idx" ON "session_reuse_links" USING btree ("kind","scope_key");--> statement-breakpoint
CREATE INDEX "session_stage_stats_stage_idx" ON "session_stage_stats" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "session_stats_started_idx" ON "session_stats" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "session_stats_host_idx" ON "session_stats" USING btree ("host_id","started_at");--> statement-breakpoint
CREATE INDEX "session_stats_plan_idx" ON "session_stats" USING btree ("plan","started_at");--> statement-breakpoint
CREATE INDEX "session_stats_scope_idx" ON "session_stats" USING btree ("scope_key");--> statement-breakpoint
CREATE INDEX "session_stats_leave_idx" ON "session_stats" USING btree ("leave_reason","started_at");--> statement-breakpoint
CREATE INDEX "session_stats_version_idx" ON "session_stats" USING btree ("schema_version");--> statement-breakpoint
CREATE INDEX "site_visit_screens_screen_idx" ON "site_visit_screens" USING btree ("screen","started_at");--> statement-breakpoint
CREATE INDEX "site_visits_started_idx" ON "site_visits" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "site_visits_participant_idx" ON "site_visits" USING btree ("participant_id","started_at");--> statement-breakpoint
CREATE INDEX "site_visits_country_idx" ON "site_visits" USING btree ("country","started_at");--> statement-breakpoint
CREATE INDEX "site_visits_device_idx" ON "site_visits" USING btree ("device_type","started_at");--> statement-breakpoint
CREATE INDEX "stats_work_origin_session_idx" ON "stats_work_origin" USING btree ("session_id");
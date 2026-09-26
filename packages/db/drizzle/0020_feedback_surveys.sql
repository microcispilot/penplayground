CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"message" text NOT NULL,
	"email" text,
	"name" text,
	"participant_id" text,
	"screen" text,
	"platform" text,
	"release" text,
	"environment" text,
	"admin_note" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text,
	"kind" text NOT NULL,
	"option" text NOT NULL,
	"other" text,
	"trigger" text NOT NULL,
	"plan" text,
	"plan_interval" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "feedback_created_idx" ON "feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "feedback_status_idx" ON "feedback" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_participant_idx" ON "feedback" USING btree ("participant_id","created_at");--> statement-breakpoint
CREATE INDEX "survey_responses_kind_idx" ON "survey_responses" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "survey_responses_participant_idx" ON "survey_responses" USING btree ("participant_id","kind","created_at");
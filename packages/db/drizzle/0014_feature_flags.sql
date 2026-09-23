CREATE TABLE "feature_flags_audits" (
	"revision" bigint PRIMARY KEY NOT NULL,
	"rules" jsonb NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	"updated_by_name" text NOT NULL,
	"reason" text NOT NULL,
	"restored_from_revision" bigint,
	CONSTRAINT "feature_flags_audits_revision" CHECK ("feature_flags_audits"."revision" > 0),
	CONSTRAINT "feature_flags_audits_restored" CHECK ("feature_flags_audits"."restored_from_revision" is null or "feature_flags_audits"."restored_from_revision" < "feature_flags_audits"."revision")
);
--> statement-breakpoint
CREATE TABLE "feature_flags_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text,
	CONSTRAINT "feature_flags_state_singleton" CHECK ("feature_flags_state"."id" = 1),
	CONSTRAINT "feature_flags_state_revision" CHECK ("feature_flags_state"."revision" >= 0)
);
--> statement-breakpoint
CREATE INDEX "feature_flags_audits_updated_idx" ON "feature_flags_audits" USING btree ("updated_at");

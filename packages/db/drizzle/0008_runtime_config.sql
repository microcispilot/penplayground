CREATE TABLE "runtime_config_audits" (
	"revision" bigint PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL,
	"updated_by_name" text NOT NULL,
	"reason" text NOT NULL,
	"restored_from_revision" bigint,
	CONSTRAINT "runtime_config_audits_revision" CHECK ("runtime_config_audits"."revision" > 0),
	CONSTRAINT "runtime_config_audits_restored" CHECK ("runtime_config_audits"."restored_from_revision" is null or "runtime_config_audits"."restored_from_revision" < "runtime_config_audits"."revision")
);
--> statement-breakpoint
CREATE TABLE "runtime_config_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text,
	CONSTRAINT "runtime_config_state_singleton" CHECK ("runtime_config_state"."id" = 1),
	CONSTRAINT "runtime_config_state_revision" CHECK ("runtime_config_state"."revision" >= 0)
);
--> statement-breakpoint
CREATE INDEX "runtime_config_audits_updated_idx" ON "runtime_config_audits" USING btree ("updated_at");
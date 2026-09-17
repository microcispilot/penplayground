CREATE TABLE "participants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"anonymous" boolean DEFAULT true NOT NULL,
	"email" text,
	"provider" text,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"title" text NOT NULL,
	"promise" text DEFAULT '' NOT NULL,
	"expert_id" text NOT NULL,
	"host_id" text NOT NULL,
	"host_name" text NOT NULL,
	"band" text NOT NULL,
	"domain" text NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"segments" integer DEFAULT 0 NOT NULL,
	"questions" integer DEFAULT 0 NOT NULL,
	"recap" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"thumbnail" text
);
--> statement-breakpoint
CREATE INDEX "sessions_host_idx" ON "sessions" USING btree ("host_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_public_idx" ON "sessions" USING btree ("visibility","views");
ALTER TABLE "sessions" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "keywords" jsonb DEFAULT '[]'::jsonb NOT NULL;
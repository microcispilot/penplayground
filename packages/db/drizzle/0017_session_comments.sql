CREATE TABLE "session_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE INDEX "session_comments_session_idx" ON "session_comments" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "session_comments_author_idx" ON "session_comments" USING btree ("author_id");
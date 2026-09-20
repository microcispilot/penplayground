CREATE TABLE "session_redirects" (
	"from_id" text PRIMARY KEY NOT NULL,
	"to_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "session_redirects_not_self" CHECK ("session_redirects"."from_id" <> "session_redirects"."to_id")
);
--> statement-breakpoint
CREATE INDEX "session_redirects_to_idx" ON "session_redirects" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX "session_saves_session_idx" ON "session_saves" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_visits_session_idx" ON "session_visits" USING btree ("session_id");
CREATE TABLE "session_likes" (
	"participant_id" text NOT NULL,
	"session_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "session_likes_participant_id_session_id_pk" PRIMARY KEY("participant_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "session_saves" (
	"participant_id" text NOT NULL,
	"session_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "session_saves_participant_id_session_id_pk" PRIMARY KEY("participant_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "session_visits" (
	"participant_id" text NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"first_joined_at" bigint NOT NULL,
	"last_joined_at" bigint NOT NULL,
	CONSTRAINT "session_visits_participant_id_session_id_pk" PRIMARY KEY("participant_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "likes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "session_likes_participant_idx" ON "session_likes" USING btree ("participant_id","created_at");--> statement-breakpoint
CREATE INDEX "session_likes_session_idx" ON "session_likes" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_saves_participant_idx" ON "session_saves" USING btree ("participant_id","created_at");--> statement-breakpoint
CREATE INDEX "session_visits_participant_idx" ON "session_visits" USING btree ("participant_id","last_joined_at");
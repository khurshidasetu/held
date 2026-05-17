import {
  mysqlTable,
  mysqlEnum,
  varchar,
  text,
  int,
  double,
  boolean,
  json,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/mysql-core";
import { relations, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// We use UUIDs everywhere instead of auto-increment so primary keys are
// unguessable and don't reveal row counts. MySQL has no native UUID type;
// we store them as CHAR(36) in canonical 8-4-4-4-12 form and generate them
// in Node before each insert (via $defaultFn).
const uuidPk = () =>
  varchar("id", { length: 36 })
    .$defaultFn(() => randomUUID())
    .primaryKey();

export type RawDiarizationSegment = {
  speaker: string;
  start: number;
  end: number;
};

export const meetings = mysqlTable(
  "meetings",
  {
    id: uuidPk(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    audioUrl: varchar("audio_url", { length: 1024 }),
    durationSeconds: int("duration_seconds"),
    status: mysqlEnum("status", [
      "pending",
      "awaiting_speaker_naming",
      "processing",
      "complete",
      "failed",
    ])
      .notNull()
      .default("pending"),
    errorMessage: text("error_message"),
    // Cached raw output from the diarization service. JSON because MySQL has
    // no JSONB; the data is small (<10 KB for typical meetings) so the lack
    // of binary representation isn't a concern.
    diarizationSegments: json("diarization_segments").$type<
      RawDiarizationSegment[]
    >(),
    // Cached word-level STT output. Populated by the /transcribe-words
    // background task that runs in parallel with /identify-speakers from
    // /upload, so by the time the user finishes naming speakers, /process
    // can skip the STT round-trip and go straight to merge + summary.
    // Each entry: { text, start, end } in seconds from audio start.
    transcriptWords: json("transcript_words").$type<
      { text: string; start: number; end: number }[]
    >(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("meetings_user_idx").on(t.userId),
    index("meetings_status_idx").on(t.status),
  ]
);

export const attendees = mysqlTable(
  "attendees",
  {
    id: uuidPk(),
    meetingId: varchar("meeting_id", { length: 36 })
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 255 }),
  },
  (t) => [index("attendees_meeting_idx").on(t.meetingId)]
);

export const speakers = mysqlTable(
  "speakers",
  {
    id: uuidPk(),
    meetingId: varchar("meeting_id", { length: 36 })
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    // The label returned by pyannote, e.g. "SPEAKER_00". For silent attendees,
    // synthesized locally, e.g. "SILENT_00".
    speakerLabel: varchar("speaker_label", { length: 64 }).notNull(),
    // User-entered name. Null falls back to "Speaker N" in the UI.
    displayName: varchar("display_name", { length: 255 }),
    isSilentAttendee: boolean("is_silent_attendee").notNull().default(false),
    // Null for silent attendees and for speakers where sample extraction failed.
    sampleAudioUrl: varchar("sample_audio_url", { length: 1024 }),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("speakers_meeting_idx").on(t.meetingId)]
);

export const transcriptSegments = mysqlTable(
  "transcript_segments",
  {
    id: uuidPk(),
    meetingId: varchar("meeting_id", { length: 36 })
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    speakerId: varchar("speaker_id", { length: 36 })
      .notNull()
      .references(() => speakers.id, { onDelete: "cascade" }),
    startSeconds: double("start_seconds").notNull(),
    endSeconds: double("end_seconds").notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    index("segments_meeting_idx").on(t.meetingId),
    index("segments_meeting_start_idx").on(t.meetingId, t.startSeconds),
  ]
);

export type ActionItem = {
  text: string;
  owner?: string | null;
  dueDate?: string | null;
};

export type Decision = {
  text: string;
  rationale?: string | null;
};

export type OpenQuestion = {
  text: string;
};

// Held's "Result Card" model: ship the answer, not a recap.
// - nextStep: the single most important next action (highlighted in UI)
// - decisions: things the meeting decided
// - actionItems: things to do, with owners + deadlines
// - openQuestions: unresolved items / parking lot
// summary is kept for the email body + the "View transcript" context view;
// it is NOT shown prominently in the Result Card itself.
export const meetingSummaries = mysqlTable(
  "meeting_summaries",
  {
    id: uuidPk(),
    meetingId: varchar("meeting_id", { length: 36 })
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    nextStep: text("next_step"),
    actionItems: json("action_items").$type<ActionItem[]>().notNull(),
    decisions: json("decisions").$type<Decision[]>().notNull(),
    openQuestions: json("open_questions").$type<OpenQuestion[]>().notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [uniqueIndex("meeting_summaries_meeting_uniq").on(t.meetingId)]
);

export const emailSends = mysqlTable(
  "email_sends",
  {
    id: uuidPk(),
    meetingId: varchar("meeting_id", { length: 36 })
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    recipientEmail: varchar("recipient_email", { length: 320 }).notNull(),
    sentAt: timestamp("sent_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    postmarkMessageId: varchar("postmark_message_id", { length: 128 }),
  },
  (t) => [index("emails_meeting_idx").on(t.meetingId)]
);

// ── Relations ─────────────────────────────────────────────────

export const meetingsRelations = relations(meetings, ({ many, one }) => ({
  attendees: many(attendees),
  speakers: many(speakers),
  transcriptSegments: many(transcriptSegments),
  summary: one(meetingSummaries),
  emailSends: many(emailSends),
}));

export const attendeesRelations = relations(attendees, ({ one }) => ({
  meeting: one(meetings, {
    fields: [attendees.meetingId],
    references: [meetings.id],
  }),
}));

export const speakersRelations = relations(speakers, ({ one, many }) => ({
  meeting: one(meetings, {
    fields: [speakers.meetingId],
    references: [meetings.id],
  }),
  segments: many(transcriptSegments),
}));

export const transcriptSegmentsRelations = relations(
  transcriptSegments,
  ({ one }) => ({
    meeting: one(meetings, {
      fields: [transcriptSegments.meetingId],
      references: [meetings.id],
    }),
    speaker: one(speakers, {
      fields: [transcriptSegments.speakerId],
      references: [speakers.id],
    }),
  })
);

export const meetingSummariesRelations = relations(
  meetingSummaries,
  ({ one }) => ({
    meeting: one(meetings, {
      fields: [meetingSummaries.meetingId],
      references: [meetings.id],
    }),
  })
);

// ── Inferred types (source of truth for the rest of the app) ──

export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;
export type MeetingStatus = Meeting["status"];

export type Attendee = typeof attendees.$inferSelect;
export type NewAttendee = typeof attendees.$inferInsert;

export type Speaker = typeof speakers.$inferSelect;
export type NewSpeaker = typeof speakers.$inferInsert;

export type TranscriptSegment = typeof transcriptSegments.$inferSelect;
export type NewTranscriptSegment = typeof transcriptSegments.$inferInsert;

export type MeetingSummary = typeof meetingSummaries.$inferSelect;
export type NewMeetingSummary = typeof meetingSummaries.$inferInsert;

export type EmailSend = typeof emailSends.$inferSelect;
export type NewEmailSend = typeof emailSends.$inferInsert;

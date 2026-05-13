import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  doublePrecision,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const meetingStatus = pgEnum("meeting_status", [
  "pending",
  "awaiting_speaker_naming",
  "processing",
  "complete",
  "failed",
]);

export type RawDiarizationSegment = {
  speaker: string;
  start: number;
  end: number;
};

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    audioUrl: text("audio_url"),
    durationSeconds: integer("duration_seconds"),
    status: meetingStatus("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    // Raw output of the diarization service. Cached between identify-speakers
    // (when it runs) and process (when we merge it with the transcript), so
    // we don't pay for diarization twice.
    diarizationSegments: jsonb("diarization_segments")
      .$type<RawDiarizationSegment[]>()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("meetings_user_idx").on(t.userId),
    index("meetings_status_idx").on(t.status),
  ]
);

export const attendees = pgTable(
  "attendees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
  },
  (t) => [index("attendees_meeting_idx").on(t.meetingId)]
);

export const speakers = pgTable(
  "speakers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    // The label returned by pyannote, e.g. "SPEAKER_00". For silent attendees,
    // synthesized locally, e.g. "SILENT_00".
    speakerLabel: text("speaker_label").notNull(),
    // User-entered name. Null falls back to "Speaker N" in the UI.
    displayName: text("display_name"),
    isSilentAttendee: boolean("is_silent_attendee").notNull().default(false),
    // Null for silent attendees and for speakers where sample extraction failed.
    sampleAudioUrl: text("sample_audio_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("speakers_meeting_idx").on(t.meetingId)]
);

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    speakerId: uuid("speaker_id")
      .notNull()
      .references(() => speakers.id, { onDelete: "cascade" }),
    startSeconds: doublePrecision("start_seconds").notNull(),
    endSeconds: doublePrecision("end_seconds").notNull(),
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

export type Topic = {
  name: string;
  summary?: string | null;
};

export const meetingSummaries = pgTable("meeting_summaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  meetingId: uuid("meeting_id")
    .notNull()
    .unique()
    .references(() => meetings.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  actionItems: jsonb("action_items").$type<ActionItem[]>().notNull().default([]),
  decisions: jsonb("decisions").$type<Decision[]>().notNull().default([]),
  topics: jsonb("topics").$type<Topic[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const emailSends = pgTable(
  "email_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    recipientEmail: text("recipient_email").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    postmarkMessageId: text("postmark_message_id"),
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

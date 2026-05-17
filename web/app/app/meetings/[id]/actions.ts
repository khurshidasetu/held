"use server";

import { getCurrentUserId } from "@/lib/auth";
import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  meetings,
  meetingSummaries,
  emailSends,
  speakers,
  transcriptSegments,
} from "@/db";
import { sendMeetingEmail } from "@/lib/postmark";
import { env } from "@/lib/env";
import { revalidatePath } from "next/cache";

const RecipientsSchema = z.array(z.string().email()).min(1);

const TitleSchema = z
  .string()
  .trim()
  .min(1, "Title cannot be empty")
  .max(255, "Title is too long");

/**
 * Merge two speakers in an already-completed meeting.
 *
 * Why this exists: the in-popup "Same as Speaker N" action only fires
 * during the awaiting_speaker_naming phase. If the user realises after
 * the transcript was generated that pyannote split one voice into two
 * (very common on solo / short recordings), or if the popup merge
 * silently failed to propagate, this is the post-hoc fix.
 *
 * Mechanics:
 *   1. Verify the meeting belongs to the caller and both speakers
 *      belong to that meeting (no cross-meeting moves).
 *   2. Reassign every transcript_segments row from `fromSpeakerId` →
 *      `intoSpeakerId`. The target row absorbs the merged-from row's
 *      text under its existing displayName.
 *   3. Delete the merged-from speaker row.
 *   4. Revalidate the meeting page so the user sees the unified
 *      transcript on next render.
 *
 * The caller can identify which speaker is which by speaker.id (UUID),
 * which the page already has on hand. Same-id from/into is a no-op.
 */
export async function mergeMeetingSpeakers(
  meetingId: string,
  fromSpeakerId: string,
  intoSpeakerId: string
): Promise<void> {
  if (fromSpeakerId === intoSpeakerId) return;

  const userId = await getCurrentUserId();

  // Ownership check on the meeting itself.
  const [meeting] = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)))
    .limit(1);
  if (!meeting) {
    throw new Error("Meeting not found");
  }

  // Both speakers must be in this meeting — prevents moving transcript
  // rows across meetings via a hand-crafted request.
  const rows = await db
    .select({ id: speakers.id })
    .from(speakers)
    .where(
      and(
        eq(speakers.meetingId, meetingId),
        inArray(speakers.id, [fromSpeakerId, intoSpeakerId])
      )
    );
  if (rows.length !== 2) {
    throw new Error("Speakers not found");
  }

  // Re-attribute every transcript row + delete the duplicate speaker.
  // Order matters slightly: rewrite the FK refs first, THEN delete the
  // row — the cascade on speakers would otherwise wipe the segments we
  // wanted to keep.
  await db
    .update(transcriptSegments)
    .set({ speakerId: intoSpeakerId })
    .where(
      and(
        eq(transcriptSegments.meetingId, meetingId),
        eq(transcriptSegments.speakerId, fromSpeakerId)
      )
    );

  await db
    .delete(speakers)
    .where(
      and(eq(speakers.meetingId, meetingId), eq(speakers.id, fromSpeakerId))
    );

  revalidatePath(`/app/meetings/${meetingId}`);
}

/**
 * Rename a meeting. Used by the inline edit on the meeting details page —
 * click the title, type, press Enter / blur to save. The action enforces
 * ownership, trims + bounds the new value, and revalidates the two pages
 * that show the title (this one + the meetings list).
 *
 * Returns the canonical trimmed title the client should display, so an
 * input value of "  Foo  " round-trips as "Foo" without a second fetch.
 */
export async function updateMeetingTitle(
  meetingId: string,
  newTitle: string
): Promise<{ title: string }> {
  const userId = await getCurrentUserId();
  const trimmed = TitleSchema.parse(newTitle);

  const [meeting] = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)))
    .limit(1);
  if (!meeting) {
    throw new Error("Meeting not found");
  }

  await db
    .update(meetings)
    .set({ title: trimmed })
    .where(eq(meetings.id, meetingId));

  revalidatePath(`/app/meetings/${meetingId}`);
  revalidatePath("/app/meetings");

  return { title: trimmed };
}

export type SendEmailsResult = {
  ok: boolean;
  sent: number;
  failed: { recipient: string; reason: string }[];
};

/**
 * Server action: send the meeting summary email to each recipient.
 *
 * Caller passes the final, deduped list (attendees + any extras the user
 * typed in the form). The action does its own auth check and validation,
 * since server actions are reachable over POST regardless of which UI
 * invokes them.
 */
export async function sendMeetingEmails(
  meetingId: string,
  recipients: string[]
): Promise<SendEmailsResult> {
  const userId = await getCurrentUserId();

  const cleaned = Array.from(
    new Set(recipients.map((r) => r.trim().toLowerCase()))
  ).filter((r) => r.length > 0);
  RecipientsSchema.parse(cleaned);

  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)))
    .limit(1);

  if (!meeting) throw new Error("Meeting not found");
  if (meeting.status !== "complete") {
    throw new Error("Meeting is not ready to send");
  }

  const [summary] = await db
    .select()
    .from(meetingSummaries)
    .where(eq(meetingSummaries.meetingId, meetingId))
    .limit(1);

  if (!summary) throw new Error("Summary not available");

  const meetingUrl = `${env.appUrl}/app/meetings/${meetingId}`;

  let sent = 0;
  const failed: { recipient: string; reason: string }[] = [];

  for (const recipient of cleaned) {
    const result = await sendMeetingEmail({
      recipient,
      meetingTitle: meeting.title,
      meetingUrl,
      summary: summary.summary,
      nextStep: summary.nextStep,
      actionItems: summary.actionItems,
      decisions: summary.decisions,
      openQuestions: summary.openQuestions,
    });

    if (result.ok) {
      sent++;
      await db.insert(emailSends).values({
        meetingId,
        recipientEmail: recipient,
        postmarkMessageId: result.messageId,
      });
    } else {
      failed.push({
        recipient,
        reason: result.errorMessage ?? "Unknown send error",
      });
    }
  }

  revalidatePath(`/app/meetings/${meetingId}`);
  return { ok: failed.length === 0, sent, failed };
}

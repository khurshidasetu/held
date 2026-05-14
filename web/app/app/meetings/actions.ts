"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db, meetings } from "@/db";
import { getCurrentUserId } from "@/lib/auth";
import { deleteUnder } from "@/lib/storage";

/**
 * Permanently delete a meeting and everything attached to it:
 *   - DB rows (attendees, speakers, transcript_segments, meeting_summaries,
 *     email_sends — all cascade off `meetings`)
 *   - Storage: meetings/<id>/* (audio) and speaker-samples/<id>/* (clips)
 *
 * Storage cleanup is best-effort; we don't block on storage failure since
 * the DB cascade is the source of truth for "this meeting no longer exists".
 */
export async function deleteMeeting(meetingId: string): Promise<void> {
  const userId = await getCurrentUserId();

  const [meeting] = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)))
    .limit(1);

  if (!meeting) {
    // Either it never existed or it belongs to someone else — same error
    // either way so we don't leak existence.
    throw new Error("Meeting not found");
  }

  await db.delete(meetings).where(eq(meetings.id, meetingId));

  // Fire and ignore storage errors — DB is the source of truth.
  Promise.all([
    deleteUnder(`meetings/${meetingId}`),
    deleteUnder(`speaker-samples/${meetingId}`),
  ]).catch((err) => {
    console.warn(`[deleteMeeting] storage cleanup partial for ${meetingId}:`, err);
  });

  revalidatePath("/app/meetings");
  revalidatePath("/app");
}

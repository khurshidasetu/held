"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { db, meetings } from "@/db";
import { getCurrentUserId } from "@/lib/auth";
import { deleteUnder } from "@/lib/storage";

/**
 * Permanently delete one or more meetings owned by the current user, along
 * with everything attached (attendees, speakers, transcript_segments,
 * meeting_summaries, email_sends — all cascade off `meetings`) and the
 * storage prefixes that hold the audio + speaker samples.
 *
 * The function is the unified path for both single-row delete (called with
 * one id) and the bulk "Delete N" action from the selection bar.
 *
 * Ownership is enforced by re-selecting the IDs against `userId` — any
 * caller-supplied IDs that don't belong to the user are silently dropped
 * (we don't leak existence). Storage cleanup is best-effort: the DB row
 * removal is the source of truth.
 *
 * Returns the count of rows that were actually deleted, so the client can
 * reflect "N deleted" honestly even when some IDs were stale.
 */
export async function deleteMeetings(
  meetingIds: string[]
): Promise<{ deleted: number }> {
  if (meetingIds.length === 0) return { deleted: 0 };

  const userId = await getCurrentUserId();

  // Filter to only IDs the current user owns. Re-selecting here is cheap
  // (PK + indexed userId) and removes any need to trust the client.
  const owned = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(eq(meetings.userId, userId), inArray(meetings.id, meetingIds)));

  const ownedIds = owned.map((m) => m.id);
  if (ownedIds.length === 0) {
    // Either none existed or none belong to this user — same outward
    // behaviour either way so we don't leak existence.
    return { deleted: 0 };
  }

  await db.delete(meetings).where(inArray(meetings.id, ownedIds));

  // Fire and ignore storage errors — DB is the source of truth for "this
  // meeting no longer exists". We do this for both prefixes per meeting.
  Promise.all(
    ownedIds.flatMap((id) => [
      deleteUnder(`meetings/${id}`),
      deleteUnder(`speaker-samples/${id}`),
    ])
  ).catch((err) => {
    console.warn(`[deleteMeetings] storage cleanup partial:`, err);
  });

  revalidatePath("/app/meetings");
  revalidatePath("/app");

  return { deleted: ownedIds.length };
}

/**
 * Backwards-compatible single-id wrapper. New code should call
 * deleteMeetings([id]) directly, but a couple of older callers still
 * use this shape and it's harmless to keep.
 */
export async function deleteMeeting(meetingId: string): Promise<void> {
  const { deleted } = await deleteMeetings([meetingId]);
  if (deleted === 0) {
    throw new Error("Meeting not found");
  }
}

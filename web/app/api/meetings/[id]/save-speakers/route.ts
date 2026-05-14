/**
 * POST /api/meetings/[id]/save-speakers
 *
 * Body:
 *   {
 *     detected: [{ speakerLabel: "SPEAKER_00", displayName: "Sarah" | null }, ...],
 *     silentAttendees: [{ displayName: "Mike" }, ...]
 *   }
 *
 * - Updates detected speakers' display_name (null is kept; UI falls back to
 *   "Speaker N").
 * - Inserts a row per silent attendee with is_silent_attendee=true and
 *   speaker_label=SILENT_NN.
 * - Transitions meeting status to 'processing'.
 * - Fires off /api/meetings/[id]/process WITHOUT awaiting it, so the user
 *   can be redirected to the meeting detail page immediately.
 */
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db, meetings, speakers } from "@/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  detected: z.array(
    z.object({
      speakerLabel: z.string(),
      displayName: z.string().nullable(),
    })
  ),
  silentAttendees: z.array(
    z.object({
      displayName: z.string().min(1),
    })
  ),
});

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Context) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, id), eq(meetings.userId, userId)))
    .limit(1);

  if (!meeting) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (meeting.status !== "awaiting_speaker_naming") {
    return NextResponse.json(
      { error: `Cannot save speakers in status ${meeting.status}` },
      { status: 409 }
    );
  }

  let body;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Update display names on detected speakers.
  for (const d of body.detected) {
    const trimmed = d.displayName?.trim();
    await db
      .update(speakers)
      .set({ displayName: trimmed && trimmed.length > 0 ? trimmed : null })
      .where(
        and(
          eq(speakers.meetingId, id),
          eq(speakers.speakerLabel, d.speakerLabel)
        )
      );
  }

  // Insert silent attendees (empty names already filtered client-side, but
  // we re-validate here defensively).
  const silents = body.silentAttendees
    .map((s) => s.displayName.trim())
    .filter((n) => n.length > 0);
  if (silents.length > 0) {
    await db.insert(speakers).values(
      silents.map((displayName, idx) => ({
        meetingId: id,
        speakerLabel: `SILENT_${String(idx).padStart(2, "0")}`,
        displayName,
        isSilentAttendee: true,
        sampleAudioUrl: null,
      }))
    );
  }

  await db
    .update(meetings)
    .set({ status: "processing", errorMessage: null })
    .where(eq(meetings.id, id));

  // Fire-and-forget the processing pipeline. We don't await — the caller
  // gets redirected and the meeting page shows the processing state.
  void triggerProcessing(id);

  return NextResponse.json({ ok: true });
}

async function triggerProcessing(meetingId: string): Promise<void> {
  try {
    await fetch(`${env.appUrl}/api/meetings/${meetingId}/process`, {
      method: "POST",
      headers: {
        "X-Internal-Secret": env.internalWorkerSecret,
      },
    });
  } catch (err) {
    console.error(
      `[save-speakers] failed to trigger processing for ${meetingId}:`,
      err
    );
  }
}

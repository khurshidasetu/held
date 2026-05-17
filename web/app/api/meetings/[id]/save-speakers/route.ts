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
import { getCurrentUserId } from "@/lib/auth";
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
  // Merge directives from the popup. `from` is a duplicate pyannote
  // speaker label, `into` is the real speaker it should be folded into.
  // We rewrite the cached diarization segments so the /process merge
  // step attributes both labels' words to the surviving row.
  // Optional for back-compat with older clients that don't send it.
  merges: z
    .array(
      z.object({
        from: z.string(),
        into: z.string(),
      })
    )
    .default([]),
});

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Context) {
  const userId = await getCurrentUserId();

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

  // ── Apply merges first ────────────────────────────────────────────────
  // Pyannote sometimes splits one real person into two speakers. The popup
  // lets the user mark a duplicate via "Same as Speaker N"; here we
  // rewrite the cached diarization segments so every segment whose
  // speaker is a `from` label gets retagged to the corresponding `into`
  // label. /process reads these segments later, so the merge "just
  // works" without any per-segment fix-up downstream. The duplicate
  // speaker rows are then deleted along with anything the user removed
  // outright.
  if (body.merges.length > 0) {
    // Resolve any chains client-side missed (defensive — the popup
    // already flattens, but a merge into a target that's itself a `from`
    // would otherwise leave dangling references).
    const mergeMap = new Map<string, string>();
    for (const m of body.merges) mergeMap.set(m.from, m.into);
    function resolve(label: string): string {
      const seen = new Set<string>();
      let cur = label;
      while (mergeMap.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = mergeMap.get(cur)!;
      }
      return cur;
    }
    const rewritten = (meeting.diarizationSegments ?? []).map((seg) => {
      const target = resolve(seg.speaker);
      return target === seg.speaker ? seg : { ...seg, speaker: target };
    });
    await db
      .update(meetings)
      .set({ diarizationSegments: rewritten })
      .where(eq(meetings.id, id));
  }

  // Reconcile detected speakers: for each existing detected row (not a silent
  // attendee), either update its display name (if the user kept it) or delete
  // it (if the user removed it via trash, or merged it into another row).
  //
  // Removed rows: their words fall out of the transcript via /process's
  // ghost-speaker prune.
  // Merged rows: their words now carry the target's label (rewritten above),
  // so deleting the duplicate row is safe — the target absorbs everything.
  const existingDetected = await db
    .select({ speakerLabel: speakers.speakerLabel })
    .from(speakers)
    .where(
      and(eq(speakers.meetingId, id), eq(speakers.isSilentAttendee, false))
    );

  const keptLabels = new Set(body.detected.map((d) => d.speakerLabel));

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

  for (const row of existingDetected) {
    if (!keptLabels.has(row.speakerLabel)) {
      await db
        .delete(speakers)
        .where(
          and(
            eq(speakers.meetingId, id),
            eq(speakers.speakerLabel, row.speakerLabel)
          )
        );
    }
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

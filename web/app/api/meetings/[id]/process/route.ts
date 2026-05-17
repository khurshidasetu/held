/**
 * POST /api/meetings/[id]/process  (internal)
 *
 * Auth: X-Internal-Secret header must match INTERNAL_WORKER_SECRET.
 *
 * Pipeline:
 *   1. Download audio from S3 (presigned)
 *   2. Transcode to 16 kHz mono PCM (ffmpeg)
 *   3. Stream PCM through Cartesia Ink-Whisper → word-level transcript
 *   4. Merge words with the cached diarization segments → named utterances
 *   5. Persist utterances to transcript_segments
 *   6. Render named transcript text and feed to Claude → summary + items + decisions + topics
 *   7. Persist meeting_summaries
 *   8. Status → 'complete' (or 'failed' on any error)
 *
 * This handler can take several minutes for long meetings. Hosting must allow
 * a request budget large enough; locally Next 16 runs without a hard cap.
 */
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  meetings,
  speakers,
  transcriptSegments,
  meetingSummaries,
} from "@/db";
import { env } from "@/lib/env";
import { getPresignedGetUrl } from "@/lib/storage";
import { downloadToTemp } from "@/lib/audio";
import { transcribeAudio } from "@/lib/stt";
import { mergeTranscript, renderNamedTranscript } from "@/lib/merge-transcript";
import { summarizeTranscript } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Context) {
  const secret = request.headers.get("x-internal-secret");
  if (secret !== env.internalWorkerSecret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;

  const [meeting] = await db
    .select()
    .from(meetings)
    .where(eq(meetings.id, id))
    .limit(1);

  if (!meeting) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (meeting.status !== "processing") {
    return NextResponse.json(
      { error: `Meeting is in ${meeting.status}, not processing` },
      { status: 409 }
    );
  }
  if (!meeting.audioUrl) {
    return NextResponse.json({ error: "No audio" }, { status: 400 });
  }
  const segments = meeting.diarizationSegments ?? [];
  if (segments.length === 0) {
    return NextResponse.json(
      { error: "No cached diarization segments" },
      { status: 400 }
    );
  }

  try {
    await runPipeline(id, meeting.audioUrl, segments);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`[process] meeting ${id} failed:`, err);
    await db
      .update(meetings)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message : "Processing failed",
      })
      .where(eq(meetings.id, id));
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

async function runPipeline(
  meetingId: string,
  audioKey: string,
  rawSegments: { speaker: string; start: number; end: number }[]
): Promise<void> {
  // Fast path: STT already ran in the background (kicked off from /upload
  // in parallel with /identify-speakers) and cached its word array on
  // the meeting row. By the time the user finishes naming speakers, this
  // is almost always populated — we skip the download + STT round trip
  // and go straight to merge + summary.
  //
  // Fallback path: cache is missing (e.g. background task hadn't started
  // yet, hit the OpenRouter guardrail, or just transient failure). Run
  // STT inline like the old single-threaded flow.
  const [cachedMeeting] = await db
    .select({ transcriptWords: meetings.transcriptWords })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);

  let words: { text: string; start: number; end: number }[];
  if (
    cachedMeeting?.transcriptWords &&
    cachedMeeting.transcriptWords.length > 0
  ) {
    console.info(
      `[process] meeting=${meetingId} using cached STT (${cachedMeeting.transcriptWords.length} words)`
    );
    words = cachedMeeting.transcriptWords;
  } else {
    console.info(
      `[process] meeting=${meetingId} STT cache miss, running inline`
    );
    const audioUrl = await getPresignedGetUrl(audioKey, 60 * 60);
    const { filePath: sourceFile, dir: tmpDir } = await downloadToTemp(
      audioUrl,
      `meeting-${meetingId}.audio`
    );
    try {
      // STT layer handles PCM transcoding internally and dispatches to the
      // configured provider (mock / cartesia / gemini-audio).
      words = await transcribeAudio(sourceFile);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    // Backfill the cache so a hypothetical re-process picks up the fast
    // path — not load-bearing, just nice.
    await db
      .update(meetings)
      .set({ transcriptWords: words })
      .where(eq(meetings.id, meetingId));
  }

  const utterances = mergeTranscript(words, rawSegments);

  // Load all speaker rows so we can resolve speakerLabel → id and display name.
  const speakerRows = await db
    .select()
    .from(speakers)
    .where(eq(speakers.meetingId, meetingId));

  // ── Prune ghost speakers ────────────────────────────────────────────────
  // pyannote sometimes returns a "speaker" that's really just a fragment of
  // background noise — visible to identify-speakers (so it gets a row and
  // a sample), survives the popup (because the user has no way to know
  // it's a ghost), then ends up with zero merged utterances here. The
  // result: a speaker row that the transcript view skips entirely, leaving
  // gaps in the positional labels ("Speaker 2", "Speaker 3", no Speaker 1).
  //
  // If a non-silent speaker has zero utterances, drop the row before we
  // build the labelToId map. Silent attendees by definition have no
  // utterances and must stay — they're skipped by the heuristic via
  // isSilentAttendee.
  const labelsWithUtterances = new Set(utterances.map((u) => u.speakerLabel));
  const ghostSpeakerIds = speakerRows
    .filter(
      (s) => !s.isSilentAttendee && !labelsWithUtterances.has(s.speakerLabel)
    )
    .map((s) => s.id);
  if (ghostSpeakerIds.length > 0) {
    console.warn(
      `[process] pruning ${ghostSpeakerIds.length} ghost speaker(s) for ${meetingId} (rows with zero merged utterances)`
    );
    await db
      .delete(speakers)
      .where(
        and(
          eq(speakers.meetingId, meetingId),
          inArray(speakers.id, ghostSpeakerIds)
        )
      );
  }

  // Re-read speakerRows after the prune so labelToId / labelToName don't
  // reference deleted rows. Cheap (PK + indexed meetingId).
  const liveSpeakerRows =
    ghostSpeakerIds.length > 0
      ? await db
          .select()
          .from(speakers)
          .where(eq(speakers.meetingId, meetingId))
      : speakerRows;

  const labelToId = new Map(liveSpeakerRows.map((s) => [s.speakerLabel, s.id]));
  const labelToName = new Map(
    liveSpeakerRows.map((s, i) => [
      s.speakerLabel,
      s.displayName ?? `Speaker ${i + 1}`,
    ])
  );

  // Persist segments. Drop utterances whose speakerLabel didn't make it into
  // the speakers table (shouldn't happen, but be defensive).
  const segmentRows = utterances
    .map((u) => {
      const speakerId = labelToId.get(u.speakerLabel);
      if (!speakerId) return null;
      return {
        meetingId,
        speakerId,
        startSeconds: u.startSeconds,
        endSeconds: u.endSeconds,
        text: u.text,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (segmentRows.length > 0) {
    // Clear any prior segments from a retry and re-insert.
    await db
      .delete(transcriptSegments)
      .where(eq(transcriptSegments.meetingId, meetingId));
    await db.insert(transcriptSegments).values(segmentRows);
  }

  const named = renderNamedTranscript(
    utterances,
    (label) => labelToName.get(label) ?? label
  );

  const summary = await summarizeTranscript(named);

  // Upsert summary row.
  await db
    .delete(meetingSummaries)
    .where(eq(meetingSummaries.meetingId, meetingId));
  await db.insert(meetingSummaries).values({
    meetingId,
    summary: summary.summary,
    nextStep: summary.nextStep,
    actionItems: summary.actionItems,
    decisions: summary.decisions,
    openQuestions: summary.openQuestions,
  });

  // Apply any self-introduced names that Claude extracted ("Hi I'm Alex" →
  // displayName="Alex"). Only fills speakers whose displayName is still
  // null — never overrides a name the user typed in the popup. The label
  // from the LLM matches the positional label we rendered into the
  // transcript ("Speaker N"), built off liveSpeakerRows (post-prune) so
  // numbering matches what the transcript will show.
  if (summary.speakerNames.length > 0) {
    const positionalToRowId = new Map<string, string>();
    liveSpeakerRows.forEach((s, i) => {
      positionalToRowId.set(`Speaker ${i + 1}`, s.id);
    });
    for (const { label, name } of summary.speakerNames) {
      const rowId = positionalToRowId.get(label);
      if (!rowId) continue;
      // Look up the row by id to check displayName — liveSpeakerRows was
      // captured before this update so it has the pre-summary state.
      const row = liveSpeakerRows.find((r) => r.id === rowId);
      if (!row || row.displayName) continue; // user-named: leave alone
      await db
        .update(speakers)
        .set({ displayName: name })
        .where(eq(speakers.id, rowId));
    }
  }

  await db
    .update(meetings)
    .set({ status: "complete", errorMessage: null })
    .where(eq(meetings.id, meetingId));
}

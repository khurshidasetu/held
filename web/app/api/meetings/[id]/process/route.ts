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
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  meetings,
  speakers,
  transcriptSegments,
  meetingSummaries,
} from "@/db";
import { env } from "@/lib/env";
import { getPresignedGetUrl } from "@/lib/s3";
import {
  downloadToTemp,
  toPcm16kMono,
} from "@/lib/audio";
import { transcribePcmFile } from "@/lib/cartesia";
import { mergeTranscript, renderNamedTranscript } from "@/lib/merge-transcript";
import { summarizeTranscript } from "@/lib/anthropic";

export const runtime = "nodejs";
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
  const audioUrl = await getPresignedGetUrl(audioKey, 60 * 60);

  const { filePath: sourceFile, dir: tmpDir } = await downloadToTemp(
    audioUrl,
    `meeting-${meetingId}.audio`
  );
  const pcmFile = path.join(
    os.tmpdir(),
    `minutely-pcm-${randomUUID()}.s16le`
  );

  let words;
  try {
    await toPcm16kMono(sourceFile, pcmFile);
    words = await transcribePcmFile(pcmFile);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(pcmFile, { force: true }).catch(() => {});
  }

  const utterances = mergeTranscript(words, rawSegments);

  // Load all speaker rows so we can resolve speakerLabel → id and display name.
  const speakerRows = await db
    .select()
    .from(speakers)
    .where(eq(speakers.meetingId, meetingId));

  const labelToId = new Map(speakerRows.map((s) => [s.speakerLabel, s.id]));
  const labelToName = new Map(
    speakerRows.map((s, i) => [
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
    actionItems: summary.actionItems,
    decisions: summary.decisions,
    topics: summary.topics,
  });

  await db
    .update(meetings)
    .set({ status: "complete", errorMessage: null })
    .where(eq(meetings.id, meetingId));
}

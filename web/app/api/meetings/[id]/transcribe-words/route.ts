/**
 * POST /api/meetings/[id]/transcribe-words  (internal, fire-and-forget)
 *
 * Runs speech-to-text on the meeting's audio and caches the resulting
 * word array on meetings.transcript_words. Triggered from /upload right
 * alongside /identify-speakers — the two run IN PARALLEL, so by the
 * time the user finishes naming speakers in the popup, the transcript
 * is already cached and /process can skip the STT step entirely.
 *
 * Auth: X-Internal-Secret. Only the upload route should call this; it
 * doesn't need the full user-session check because the meeting ID +
 * shared secret is enough to authorise the background task. (Same
 * pattern as /process.)
 *
 * Idempotent: if transcript_words is already populated, returns 200
 * without re-running STT. Safe to retry.
 *
 * Best-effort: any STT failure is logged but DOES NOT mark the meeting
 * as failed. /process will fall back to running STT inline if this
 * cache misses for any reason.
 */
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, meetings } from "@/db";
import { env } from "@/lib/env";
import { getPresignedGetUrl } from "@/lib/storage";
import { downloadToTemp } from "@/lib/audio";
import { transcribeAudio } from "@/lib/stt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// STT for a long meeting can take a minute or two — give it room.
export const maxDuration = 300;

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
  if (!meeting.audioUrl) {
    return NextResponse.json({ error: "No audio" }, { status: 400 });
  }

  // Already cached — caller can move on.
  if (Array.isArray(meeting.transcriptWords) && meeting.transcriptWords.length > 0) {
    return NextResponse.json({
      ok: true,
      cached: true,
      wordCount: meeting.transcriptWords.length,
    });
  }

  // Same audio path /process uses (S3 or local; getPresignedGetUrl picks).
  const audioUrl = await getPresignedGetUrl(meeting.audioUrl, 60 * 60);

  const { filePath: sourceFile, dir: tmpDir } = await downloadToTemp(
    audioUrl,
    `meeting-${id}.audio`
  );

  try {
    const words = await transcribeAudio(sourceFile);
    await db
      .update(meetings)
      .set({ transcriptWords: words })
      .where(eq(meetings.id, id));
    console.info(
      `[transcribe-words] meeting=${id} cached ${words.length} words`
    );
    return NextResponse.json({ ok: true, cached: false, wordCount: words.length });
  } catch (err) {
    // Best-effort. Don't mark the meeting failed — /process will retry
    // inline as a fallback. Logging only.
    console.warn(`[transcribe-words] meeting=${id} STT failed:`, err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "STT failed" },
      { status: 200 }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

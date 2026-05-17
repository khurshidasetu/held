/**
 * POST /api/meetings/[id]/identify-speakers
 *
 * Called fire-and-forget by /api/meetings/upload after the audio lands. The
 * route runs the SYNCHRONOUS critical path needed for the popup to appear:
 *
 *   1. Diarize (slowest step — pyannote on CPU dominates this route's time)
 *   2. Extract a short MP3 sample per detected speaker
 *   3. Insert speaker rows with displayName: null
 *   4. Cache the raw diarization segments on the meeting row
 *
 * As soon as those four steps are done, the meeting page poll picks up
 * speakers.count > 0 and swaps the "Identifying speakers..." spinner for
 * the SpeakerNamingPopup.
 *
 * Name inference (download audio → STT → LLM → patch displayName) runs
 * fire-and-forget in the background. Self-introduced names trickle into
 * the DB whenever it finishes. The popup uses local state once mounted,
 * so any names that arrive after the popup is open won't auto-fill — but
 * users can still type names manually, and /process re-runs name
 * extraction during summarization as the authoritative fallback.
 *
 * The meeting stays in status 'awaiting_speaker_naming' throughout — only
 * the save-speakers endpoint advances it.
 */
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { getCurrentUserId } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { db, meetings, speakers } from "@/db";
import { diarize } from "@/lib/diarization";
import { cleanSegments } from "@/lib/merge-transcript";
import { extractSpeakerSamples } from "@/lib/extract-samples";
import {
  getPresignedGetUrl,
  getPresignedGetUrlForBrowser,
  getInternalPresignedGetUrl,
} from "@/lib/storage";
import { downloadToTemp } from "@/lib/audio";
import { transcribeAudio } from "@/lib/stt";
import { mergeTranscript, renderNamedTranscript } from "@/lib/merge-transcript";
import { extractSpeakerNames } from "@/lib/llm";

export const runtime = "nodejs";
// Reads DB + calls external service, never prerender.
export const dynamic = "force-dynamic";
// Diarization can run 30-60s on short clips. Tell Next not to time out.
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Context) {
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
  if (!meeting.audioUrl) {
    return NextResponse.json(
      { error: "Meeting has no audio" },
      { status: 400 }
    );
  }
  if (meeting.status !== "awaiting_speaker_naming") {
    return NextResponse.json(
      { error: `Cannot identify speakers in status ${meeting.status}` },
      { status: 409 }
    );
  }

  // Two URLs over the same key:
  //   - audioUrlForDiarization: handed to the diarization service. When that
  //     service runs in Docker, the URL uses host.docker.internal so the
  //     container can reach our dev server on the host.
  //   - audioUrlForLocal:       used by extractSpeakerSamples (this process)
  //     and the background name-inference task. Plain localhost is fine
  //     and avoids a pointless trip through Docker's networking.
  const audioUrlForDiarization = await getInternalPresignedGetUrl(
    meeting.audioUrl,
    30 * 60
  );
  const audioUrlForLocal = await getPresignedGetUrl(meeting.audioUrl, 30 * 60);

  let segments;
  try {
    segments = await diarize(audioUrlForDiarization);
  } catch (err) {
    console.error(`[identify-speakers] diarization failed for ${id}:`, err);
    await db
      .update(meetings)
      .set({
        status: "failed",
        errorMessage:
          err instanceof Error ? err.message : "Diarization failed",
      })
      .where(eq(meetings.id, id));
    return NextResponse.json(
      { error: "Diarization failed" },
      { status: 502 }
    );
  }

  if (segments.length === 0) {
    return NextResponse.json(
      { error: "No speech detected in the recording" },
      { status: 422 }
    );
  }

  // ── Clean + prune ghost speakers BEFORE the popup ───────────────────────
  //
  // pyannote routinely over-splits a single voice into multiple "speakers"
  // — especially on solo or short recordings — because its embedding
  // clustering can flip on tiny shifts in tone / distance to mic /
  // background noise. The user sees 5 rows in the naming popup when they
  // only spoke once. The earlier /process-time ghost-prune ran AFTER the
  // popup had already shown the user those rows, which is too late.
  //
  // Two passes here:
  //   1. cleanSegments — drop sub-100ms blips, merge adjacent same-speaker
  //      segments with gap <= 500ms (existing helper used by mergeTranscript).
  //   2. Drop any speaker whose TOTAL post-clean speech is under
  //      MIN_TOTAL_SPEECH_SECONDS. That threshold (1.0 s) is comfortably
  //      below any real participant's contribution and reliably catches
  //      noise/phantom clusters that pyannote keeps spitting out.
  const cleaned = cleanSegments(segments);
  const MIN_TOTAL_SPEECH_SECONDS = 1.0;
  const totalsBySpeaker = new Map<string, number>();
  for (const s of cleaned) {
    totalsBySpeaker.set(
      s.speaker,
      (totalsBySpeaker.get(s.speaker) ?? 0) + (s.end - s.start)
    );
  }
  const keptSpeakers = new Set(
    Array.from(totalsBySpeaker.entries())
      .filter(([, total]) => total >= MIN_TOTAL_SPEECH_SECONDS)
      .map(([label]) => label)
  );
  let usableSegments = cleaned.filter((s) => keptSpeakers.has(s.speaker));

  // Edge case: every speaker fell below the threshold. Don't fail the
  // meeting — fall back to the cleaned set so the user still gets *something*
  // (the trash button in the popup will deal with the rest).
  if (usableSegments.length === 0) {
    console.warn(
      `[identify-speakers] all speakers below ${MIN_TOTAL_SPEECH_SECONDS}s threshold for ${id}; falling back to cleaned segments`
    );
    usableSegments = cleaned;
  }

  if (keptSpeakers.size < totalsBySpeaker.size) {
    console.info(
      `[identify-speakers] meeting ${id}: pruned ${
        totalsBySpeaker.size - keptSpeakers.size
      } ghost speaker(s) (total speech < ${MIN_TOTAL_SPEECH_SECONDS}s)`
    );
  }

  // Use the pruned + cleaned segments for everything downstream — sample
  // extraction, the speaker rows we insert, and the diarizationSegments
  // we cache for /process. mergeTranscript will run cleanSegments again
  // later (idempotent) but starts from a smaller, sharper input.
  segments = usableSegments;

  const { sampleKeysByLabel, speakerLabels } = await extractSpeakerSamples({
    meetingId: id,
    audioSourceUrl: audioUrlForLocal,
    segments,
  });

  // Single clear+insert. The previous version deleted twice — once before
  // name inference, once after — which was a leftover from when inference
  // was synchronous. With inference deferred we only need the one wipe.
  await db.delete(speakers).where(eq(speakers.meetingId, id));

  await db.insert(speakers).values(
    speakerLabels.map((label) => ({
      meetingId: id,
      speakerLabel: label,
      // Store the storage KEY, not a signed URL. The meeting page re-signs
      // per render so the URL is always fresh + origin-relative.
      sampleAudioUrl: sampleKeysByLabel.get(label) ?? null,
      isSilentAttendee: false,
      // null on purpose — name inference runs in the background below and
      // patches this column when (and if) self-intros are detected.
      displayName: null,
    }))
  );

  // Cache the raw diarization output so /process can merge it with the
  // transcript without re-running diarization.
  await db
    .update(meetings)
    .set({ diarizationSegments: segments })
    .where(eq(meetings.id, id));

  // ── Fire-and-forget: background name inference ─────────────────────────
  // Best-effort STT + LLM call that tries to pull self-introductions out of
  // the audio ("Hi I'm Alex", "ami Rakib bolchi"). Updates speakers.display_name
  // in place when matches land. The route returns BEFORE this resolves so
  // the popup can appear immediately.
  void inferNamesInBackground({
    meetingId: id,
    audioUrlForLocal,
    segments,
    speakerLabels,
  });

  // Build the response payload — signed relative URLs for any client that
  // wants to use the response directly. (The meeting page polls and signs
  // its own URLs server-side, so this payload is mostly informational.)
  const responseSpeakers = await Promise.all(
    speakerLabels.map(async (label) => {
      const key = sampleKeysByLabel.get(label) ?? null;
      return {
        speakerLabel: label,
        sampleUrl: key ? await getPresignedGetUrlForBrowser(key, 60 * 60) : null,
        inferredName: null,
      };
    })
  );
  return NextResponse.json({ speakers: responseSpeakers });
}

/**
 * Background name inference. Downloads the audio, transcribes it, asks
 * the LLM to pull self-introductions out of the resulting transcript,
 * and updates speakers.display_name for any speaker whose label maps
 * cleanly back to a pyannote label.
 *
 * Failures here are silent on purpose — the popup still works without
 * pre-filled names, and /process runs its own name extraction during
 * summarization as the final fallback.
 */
async function inferNamesInBackground({
  meetingId,
  audioUrlForLocal,
  segments,
  speakerLabels,
}: {
  meetingId: string;
  audioUrlForLocal: string;
  segments: { speaker: string; start: number; end: number }[];
  speakerLabels: string[];
}): Promise<void> {
  let tmpDir: string | undefined;
  try {
    const dl = await downloadToTemp(audioUrlForLocal, "identify-audio");
    tmpDir = dl.dir;
    const words = await transcribeAudio(dl.filePath);
    if (words.length === 0) return;

    const utterances = mergeTranscript(words, segments);
    if (utterances.length === 0) return;

    // Positional labels for the LLM prompt — same scheme the popup uses.
    const positionalLabelFor = (pyannoteLabel: string) => {
      const idx = speakerLabels.indexOf(pyannoteLabel);
      return idx >= 0 ? `Speaker ${idx + 1}` : pyannoteLabel;
    };
    const named = renderNamedTranscript(utterances, positionalLabelFor);

    const extracted = await extractSpeakerNames(named);
    for (const { label, name } of extracted) {
      const match = label.match(/^Speaker\s+(\d+)$/i);
      if (!match) continue;
      const idx = parseInt(match[1], 10) - 1;
      const pyannoteLabel = speakerLabels[idx];
      if (!pyannoteLabel) continue;

      // Patch the displayName. Save-speakers later overwrites whatever
      // the user typed anyway, so we don't need to guard against
      // clobbering — but in practice, if inference finishes before the
      // user has typed, this is a free pre-fill on the next render.
      await db
        .update(speakers)
        .set({ displayName: name })
        .where(
          and(
            eq(speakers.meetingId, meetingId),
            eq(speakers.speakerLabel, pyannoteLabel)
          )
        );
    }
  } catch (err) {
    console.warn(`[identify-speakers] background name inference failed:`, err);
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

"use client";

/**
 * Shown on the meeting page right after upload, while pyannote diarization
 * runs in the background (kicked off fire-and-forget from /api/meetings/upload).
 *
 * The component polls /status every 2 seconds. The MOMENT diarization
 * completes the server-side handler attaches the speakers rows; we don't
 * see that here directly, but a fresh router.refresh() will pull them in
 * and the parent page will swap us out for the SpeakerNamingPopup. We
 * exit the polling loop as soon as the status is no longer
 * "awaiting_speaker_naming" with zero speakers.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function MeetingIdentifyingState({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        // We just need to know "did the speakers materialize?" — the
        // /status endpoint only returns the meeting status, not the
        // speakers count. Easiest: just refresh the page tree; the server
        // component re-runs, fetches speakers fresh, and re-renders us
        // OR the naming state.
        router.refresh();
      } catch {
        // ignore — keep polling
      }
      if (!cancelled) timer = setTimeout(poll, 2500);
    }
    timer = setTimeout(poll, 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [router]);

  return (
    <div className="page-fade flex flex-col items-center justify-center min-h-[70dvh] sm:min-h-[60vh] text-center space-y-4 px-6">
      <div className="h-10 w-10 rounded-full border-4 border-brand/20 border-t-brand animate-spin" />
      <div className="max-w-sm">
        <div className="font-medium">Identifying speakers&hellip;</div>
        <p className="text-sm text-muted-foreground mt-1">
          Detecting distinct voices in your recording. On CPU this is the
          slowest step &mdash; usually under a minute for short clips.
        </p>
        <p className="text-xs text-muted-foreground mt-3 tabular-nums">
          Working for {formatElapsed(elapsed)}&hellip;
        </p>
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

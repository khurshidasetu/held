"use client";

/**
 * Shown on the meeting page right after upload, while pyannote diarization
 * runs in the background (kicked off fire-and-forget from /api/meetings/upload).
 *
 * The component polls every 2.5 seconds. The MOMENT diarization completes
 * the server-side identify-speakers handler attaches the speakers rows;
 * a fresh router.refresh() pulls them in and the parent page swaps us out
 * for the SpeakerNamingPopup.
 *
 * The wait can be 60+s on CPU pyannote, which is too long to stare at a
 * spinner — so we surface a "Continue in background" escape hatch after
 * the first ~5s. It just navigates to /app/meetings; the recording stays
 * safely in the DB and the user can name speakers from the list whenever
 * they come back.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function MeetingIdentifyingState({ meetingId: _meetingId }: { meetingId: string }) {
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

  // After ~5s of waiting, surface the "I'll come back later" link so users
  // who don't want to stare at a spinner can keep working. Recording is
  // already saved server-side, so navigating away is safe.
  const showEscapeHatch = elapsed >= 5;

  return (
    <div className="page-fade flex flex-col items-center justify-center min-h-[70dvh] sm:min-h-[60vh] text-center space-y-4 px-6">
      <div className="h-10 w-10 rounded-full border-4 border-brand/20 border-t-brand animate-spin" />
      <div className="max-w-sm">
        <div className="font-medium">Identifying speakers&hellip;</div>
        <p className="text-sm text-muted-foreground mt-1">
          Recording is safely saved. We&rsquo;re detecting distinct voices in
          the background &mdash; on CPU this is the slowest step, usually
          under a minute for short clips.
        </p>
        <p className="text-xs text-muted-foreground mt-3 tabular-nums">
          Working for {formatElapsed(elapsed)}&hellip;
        </p>
      </div>
      {showEscapeHatch && (
        <Link
          href="/app/meetings"
          className="tap-target inline-flex items-center gap-1 px-3 py-2 text-sm text-brand hover:text-brand-hover font-medium"
        >
          Continue in background &rarr;
        </Link>
      )}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

"use client";

/**
 * Client component that polls the meeting until its status leaves
 * 'processing' / 'pending'. When it does, we refresh the server component
 * tree so the user sees the transcript and summary without a hard reload.
 *
 * The wrapper uses min-h-[70dvh] so the spinner sits in the middle of the
 * visible viewport on both desktop and mobile (vh would include the iOS
 * URL bar area and push the centerline up). We also tick a small "elapsed"
 * counter so a slow real run doesn't feel hung — gives the user a sense
 * that work is still happening.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Meeting } from "@/db";

export function MeetingProcessingState({ meeting }: { meeting: Meeting }) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);

  // Tick once a second so we can show a humane "Working for Ns…" line.
  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch(`/api/meetings/${meeting.id}/status`, {
          cache: "no-store",
        });
        if (res.ok) {
          const { status } = (await res.json()) as { status: string };
          if (status === "complete" || status === "failed") {
            router.refresh();
            return;
          }
        }
      } catch {
        // Network blip — keep polling.
      }
      if (!cancelled) timer = setTimeout(poll, 4000);
    }
    timer = setTimeout(poll, 4000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [meeting.id, router]);

  return (
    <div className="page-fade flex flex-col items-center justify-center min-h-[70dvh] sm:min-h-[60vh] text-center space-y-4 px-6">
      <div className="h-10 w-10 rounded-full border-4 border-brand/20 border-t-brand animate-spin" />
      <div className="max-w-sm">
        <div className="font-medium">Processing your meeting&hellip;</div>
        <p className="text-sm text-muted-foreground mt-1">
          Diarizing speakers, transcribing audio, and writing the Result Card.
          On CPU this can take a few minutes for short clips.
        </p>
        <p className="text-xs text-muted-foreground mt-3 tabular-nums">
          Working for {formatElapsed(elapsed)}…
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

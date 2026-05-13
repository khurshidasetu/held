"use client";

/**
 * Client component that polls the meeting until its status leaves
 * 'processing' / 'pending'. When it does, we refresh the server component
 * tree so the user sees the transcript and summary without a hard reload.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Meeting } from "@/db";

export function MeetingProcessingState({ meeting }: { meeting: Meeting }) {
  const router = useRouter();

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
    <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
      <div className="h-10 w-10 rounded-full border-4 border-brand/20 border-t-brand animate-spin" />
      <div>
        <div className="font-medium">Processing your meeting&hellip;</div>
        <p className="text-sm text-muted-foreground mt-1">
          Transcribing audio and generating a summary. This usually takes a
          minute or two for short meetings.
        </p>
      </div>
    </div>
  );
}

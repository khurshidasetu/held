"use client";

import { useState, useTransition } from "react";
import { deleteMeeting } from "./actions";

/**
 * Per-row delete button on /app/meetings. Confirms via `window.confirm`
 * (cheap and accessible enough for v0), then fires the server action. The
 * action revalidates the list path so the row disappears on success.
 */
export function DeleteMeetingButton({
  meetingId,
  title,
}: {
  meetingId: string;
  title: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    const ok = window.confirm(
      `Delete "${title}"? This removes the recording, transcript, and summary permanently.`
    );
    if (!ok) return;
    setError(null);
    startTransition(async () => {
      try {
        await deleteMeeting(meetingId);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Delete failed");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-label={`Delete meeting: ${title}`}
        title="Delete meeting"
        className="tap-target inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-500/10 disabled:opacity-50"
      >
        {pending ? <Spinner /> : <TrashIcon />}
      </button>
      {error && (
        <span
          role="alert"
          className="text-xs text-red-600 ml-2"
        >
          {error}
        </span>
      )}
    </>
  );
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="18"
      height="18"
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6" />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin"
      aria-hidden="true"
    />
  );
}

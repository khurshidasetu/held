"use client";

/**
 * Inline-editable meeting title for the details page.
 *
 * Click the title (or the trailing pencil affordance on hover) → swap to
 * an autofocused input pre-populated with the current value.
 *
 *   Enter      → save
 *   Blur       → save (same path as Enter so users don't lose changes
 *                by clicking away)
 *   Escape     → cancel without saving
 *   Empty/same → no server call, just exit edit mode
 *
 * The component is optimistic: on save it updates local state immediately
 * and kicks off the server action via useTransition. If the action throws
 * (validation failure, ownership mismatch) we roll local state back to the
 * last-known-good value and surface the error inline.
 *
 * The component is intentionally self-contained — no parent revalidation
 * needed for the title to update visually, though the action also
 * revalidates so the meetings list reflects the new title.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { updateMeetingTitle } from "./actions";

type Props = {
  meetingId: string;
  initialTitle: string;
};

export function EditableMeetingTitle({ meetingId, initialTitle }: Props) {
  const [title, setTitle] = useState(initialTitle);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialTitle);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks an in-flight save so the onBlur handler can decide whether
  // it's the "user clicked elsewhere → save" path vs the "we just
  // programmatically blurred after save" path.
  const justSavedRef = useRef(false);

  // If the parent re-renders with a different initialTitle (e.g. another
  // tab renamed it and we revalidated), pick it up — unless the user is
  // mid-edit, in which case never clobber their typing.
  useEffect(() => {
    if (!editing) {
      setTitle(initialTitle);
      setDraft(initialTitle);
    }
  }, [initialTitle, editing]);

  // Autofocus + select-all on entering edit mode so the user can either
  // overwrite or extend the existing title without an extra click.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function startEdit() {
    setDraft(title);
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setDraft(title);
    setError(null);
    setEditing(false);
  }

  function commit() {
    const next = draft.trim();
    // Same value or empty → no server round-trip, just exit edit mode.
    if (next.length === 0 || next === title) {
      setEditing(false);
      setError(null);
      return;
    }
    // Optimistic: update display state, fire the action.
    const previous = title;
    setTitle(next);
    setEditing(false);
    setError(null);
    justSavedRef.current = true;
    startTransition(async () => {
      try {
        const result = await updateMeetingTitle(meetingId, next);
        // Server might canonicalise (extra whitespace removed etc); accept
        // its version as the source of truth.
        if (result.title !== next) setTitle(result.title);
      } catch (e) {
        // Roll back optimistic update.
        setTitle(previous);
        setDraft(previous);
        setError(e instanceof Error ? e.message : "Could not save");
        setEditing(true);
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  if (editing) {
    return (
      <div className="mt-1">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // After commit() runs setEditing(false), React may fire a
            // blur from the unmount; guard against double-commit.
            if (justSavedRef.current) {
              justSavedRef.current = false;
              return;
            }
            commit();
          }}
          disabled={pending}
          maxLength={255}
          aria-label="Meeting title"
          className="w-full max-w-xl text-2xl font-semibold tracking-tight bg-background border border-border rounded-md px-2 py-1 -ml-2 focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
        />
        {error && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {error}
          </p>
        )}
      </div>
    );
  }

  // Display mode: the h1 needs to be block-level so it stacks under the
  // "← Previous meetings" link (which is an inline <a>). We use `flex`
  // (block-level flex) on the h1 + `w-fit` so the hover/focus background
  // hugs just the title text, not the full row width.
  return (
    <h1
      role="button"
      tabIndex={0}
      onClick={startEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          startEdit();
        }
      }}
      title="Click to rename"
      aria-label={`Meeting title: ${title}. Click to rename.`}
      className="group flex w-fit max-w-full items-center gap-2 mt-1 text-2xl font-semibold tracking-tight cursor-text rounded-md px-2 -ml-2 py-0.5 hover:bg-foreground/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand transition-colors"
    >
      <span className="truncate">{title}</span>
      <PencilIcon className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity" />
    </h1>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="16"
      height="16"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

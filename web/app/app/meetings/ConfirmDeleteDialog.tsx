"use client";

/**
 * Confirmation modal used by both the per-row trash button and the bulk
 * "Delete N" action in the selection bar. Replaces the old
 * `window.confirm` flow — modal styling matches the rest of the app
 * (rounded-2xl card, brand colours, safe-area-aware), and the same dialog
 * handles single-delete (shows the title) and bulk-delete (shows the
 * count) without two components.
 *
 * Accessibility:
 *   - role="dialog" + aria-modal + labelled by the heading
 *   - ESC cancels
 *   - Backdrop click cancels (only when the click is on the backdrop itself
 *     — clicks inside the card don't bubble through)
 *   - Confirm button auto-focuses on open so keyboard users land on the
 *     action; cancel is one tab away
 */
import { useEffect } from "react";

type Props = {
  /** True when the dialog is mounted/visible. */
  open: boolean;
  /** How many meetings the user is about to delete. */
  count: number;
  /** If single-delete, the meeting's title — rendered in the body for
   *  context. Ignored when count > 1. */
  title?: string;
  /** Disables both buttons + the Esc/backdrop cancel paths. */
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDeleteDialog({
  open,
  count,
  title,
  pending,
  onCancel,
  onConfirm,
}: Props) {
  // ESC to cancel. We mount/unmount the listener based on `open` so a
  // stack of dialogs (none for now, but future-proof) doesn't double-handle.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, pending, onCancel]);

  if (!open) return null;

  const isSingle = count === 1;
  const heading = isSingle ? "Delete meeting?" : `Delete ${count} meetings?`;
  const body = isSingle
    ? title
      ? `“${title}” — recording, transcript, and summary will be removed permanently.`
      : "The recording, transcript, and summary will be removed permanently."
    : `${count} recordings, transcripts, and summaries will be removed permanently.`;

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-title"
      onClick={(e) => {
        // Backdrop click closes; clicks inside the card don't reach here
        // because the card stops propagation implicitly (its own children
        // are the click targets).
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
    >
      <div className="dialog-card w-full max-w-sm bg-card text-card-foreground rounded-2xl shadow-2xl p-5 space-y-4">
        <div>
          <h2
            id="confirm-delete-title"
            className="text-lg font-semibold tracking-tight"
          >
            {heading}
          </h2>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
            {body}
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            This can&rsquo;t be undone.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="tap-target inline-flex items-center px-4 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            autoFocus
            className="tap-target inline-flex items-center px-4 py-2 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-40"
          >
            {pending
              ? "Deleting…"
              : isSingle
                ? "Delete"
                : `Delete ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}

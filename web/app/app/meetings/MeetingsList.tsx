"use client";

/**
 * Selectable list of meetings on /app/meetings.
 *
 * Three behaviours layered on top of the original row layout:
 *
 *   1. Per-row checkbox toggles selection. The "Select" header row has a
 *      master checkbox that selects/clears all.
 *   2. Tapping the row body navigates to the meeting *unless* anything is
 *      already selected — in that case the tap toggles selection instead,
 *      so list-edit mode feels like one cohesive mode (matches Gmail/Mail).
 *   3. When 1+ rows are selected, a bottom action bar slides up with the
 *      count and a "Delete N" button. The per-row trash icon stays hidden
 *      while in selection mode so there's only one way to act on a set.
 *
 * Both the per-row trash and the bulk delete fan into ConfirmDeleteDialog
 * (no more window.confirm). The dialog drives the same server action,
 * deleteMeetings([...]), so single + bulk share one code path.
 */
import Link from "next/link";
import { useState, useTransition } from "react";
import type { MeetingStatus } from "@/db";
import { deleteMeetings } from "./actions";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";

export type MeetingRow = {
  id: string;
  title: string;
  createdAt: Date;
  durationSeconds: number | null;
  status: MeetingStatus;
};

const statusLabels: Record<MeetingStatus, string> = {
  pending: "Pending",
  awaiting_speaker_naming: "Naming speakers",
  processing: "Processing",
  complete: "Complete",
  failed: "Failed",
};

const statusClasses: Record<MeetingStatus, string> = {
  pending: "bg-muted/20 text-muted-foreground",
  awaiting_speaker_naming: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  processing: "bg-brand/10 text-brand",
  complete: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
};

export function MeetingsList({ meetings }: { meetings: MeetingRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // `confirmFor` doubles as the open/closed flag: non-null = dialog open,
  // and it carries enough info to render the right heading (single vs bulk)
  // and confirm the right id set.
  const [confirmFor, setConfirmFor] = useState<{
    ids: string[];
    title?: string;
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const someSelected = selected.size > 0;
  const allSelected =
    meetings.length > 0 && selected.size === meetings.length;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === meetings.length ? new Set() : new Set(meetings.map((m) => m.id))
    );
  }

  function askDeleteSingle(m: MeetingRow) {
    setError(null);
    setConfirmFor({ ids: [m.id], title: m.title });
  }

  function askDeleteSelected() {
    setError(null);
    setConfirmFor({ ids: Array.from(selected) });
  }

  function confirm() {
    if (!confirmFor) return;
    const ids = confirmFor.ids;
    startTransition(async () => {
      try {
        await deleteMeetings(ids);
        setConfirmFor(null);
        // Strip the deleted ids out of selection so the bar updates
        // correctly when only some were deleted (or all).
        setSelected((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Delete failed");
      }
    });
  }

  return (
    <>
      <ul
        className={`divide-y divide-border border border-border rounded-lg overflow-hidden bg-card ${
          someSelected ? "mb-20" : ""
        }`}
      >
        {/* Master select / header row */}
        <li className="flex items-center px-2 py-1 bg-foreground/[0.02] text-xs text-muted-foreground">
          <label className="tap-target inline-flex items-center gap-2 px-2 py-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              aria-label={allSelected ? "Deselect all" : "Select all"}
              className="h-4 w-4 accent-brand cursor-pointer"
            />
            <span>
              {someSelected ? `${selected.size} selected` : "Select"}
            </span>
          </label>
        </li>

        {meetings.map((m) => {
          const isSelected = selected.has(m.id);
          return (
            <li
              key={m.id}
              className={`flex items-center transition-colors ${
                isSelected
                  ? "bg-brand/5 hover:bg-brand/10"
                  : "hover:bg-foreground/5"
              }`}
            >
              <label
                className="tap-target shrink-0 flex items-center justify-center px-3 py-3 cursor-pointer"
                // Stop propagation so clicking the checkbox doesn't also
                // bubble up to the row Link's onClick.
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleOne(m.id)}
                  aria-label={`Select meeting: ${m.title}`}
                  className="h-4 w-4 accent-brand cursor-pointer"
                />
              </label>

              <Link
                href={`/app/meetings/${m.id}`}
                className="flex-1 min-w-0 flex items-center justify-between gap-4 pl-1 pr-4 py-2"
                onClick={(e) => {
                  // While anything is selected, the list is in "edit mode" —
                  // tapping a row toggles it instead of navigating away. This
                  // matches Gmail/Apple Mail behaviour and keeps users from
                  // accidentally leaving the selection.
                  if (someSelected) {
                    e.preventDefault();
                    toggleOne(m.id);
                  }
                }}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate leading-tight">
                    {m.title}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {new Date(m.createdAt).toLocaleString()}
                    {m.durationSeconds
                      ? ` · ${formatDuration(m.durationSeconds)}`
                      : null}
                  </div>
                </div>
                <span
                  className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full font-medium ${statusClasses[m.status]}`}
                >
                  {statusLabels[m.status]}
                </span>
              </Link>

              {/* Per-row trash hides while in selection mode — the bottom
                  action bar is the only way to act when a set is chosen.
                  Outside selection mode, this is the one-off shortcut. */}
              {!someSelected && (
                <div className="shrink-0 pr-2">
                  <button
                    type="button"
                    onClick={() => askDeleteSingle(m)}
                    aria-label={`Delete meeting: ${m.title}`}
                    title="Delete meeting"
                    className="tap-target inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-500/10"
                  >
                    <TrashIcon />
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p role="alert" className="text-sm text-red-600 mt-3">
          {error}
        </p>
      )}

      {/* Floating selection pill — appears only when ≥1 selected. Centered
          at the bottom, compact (auto-width), inverted colour scheme
          (bg-foreground on the page background) so it reads as a discrete
          floating chip rather than a full-width footer. Wrapper handles
          fixed positioning + safe-area inset; inner div carries the
          slide-up entrance so the two transforms don't fight. */}
      {someSelected && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-0 z-40 px-4 pointer-events-none"
          style={{
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)",
          }}
        >
          <div
            className="slide-up-pill pointer-events-auto flex items-center gap-1 bg-foreground/95 text-background backdrop-blur rounded-full pl-4 pr-1.5 py-1.5 shadow-2xl shadow-black/30 ring-1 ring-background/10"
            role="region"
            aria-label="Selection actions"
          >
            <div className="text-sm font-medium whitespace-nowrap">
              {selected.size} selected
            </div>
            <div
              className="h-5 w-px bg-background/20 mx-2"
              aria-hidden="true"
            />
            <button
              type="button"
              onClick={askDeleteSelected}
              disabled={pending}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-40 transition-colors"
            >
              <TrashIcon />
              <span>Delete</span>
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              disabled={pending}
              aria-label="Clear selection"
              title="Clear selection"
              className="inline-flex items-center justify-center h-9 w-9 rounded-full hover:bg-background/10 disabled:opacity-40 transition-colors"
            >
              <XIcon />
            </button>
          </div>
        </div>
      )}

      <ConfirmDeleteDialog
        open={!!confirmFor}
        count={confirmFor?.ids.length ?? 0}
        title={confirmFor?.title}
        pending={pending}
        onCancel={() => {
          if (!pending) setConfirmFor(null);
        }}
        onConfirm={confirm}
      />
    </>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
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
      aria-hidden="true"
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6" />
    </svg>
  );
}

function XIcon() {
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
      aria-hidden="true"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

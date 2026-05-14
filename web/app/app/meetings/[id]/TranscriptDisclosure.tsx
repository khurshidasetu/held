"use client";

import { useState } from "react";

/**
 * Held's transcript is "forensic evidence, one swipe away". Hidden by default,
 * revealed only when the user explicitly asks for it. The product surface
 * stays focused on the Result Card.
 */
export function TranscriptDisclosure({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="tap-target inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <span
          className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        >
          ▸
        </span>
        {open ? "Hide transcript" : "View transcript"}
      </button>
      {open && <div className="mt-3">{children}</div>}
    </section>
  );
}

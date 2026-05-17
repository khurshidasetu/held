import Image from "next/image";
import Link from "next/link";
import { count, eq } from "drizzle-orm";
import { db, meetings } from "@/db";
import { getCurrentUserId } from "@/lib/auth";
import { Recorder } from "@/components/Recorder";

export const dynamic = "force-dynamic";

export default async function CapturePage() {
  const userId = await getCurrentUserId();

  // Just the count — the list itself lives at /app/meetings.
  const [{ n }] = await db
    .select({ n: count() })
    .from(meetings)
    .where(eq(meetings.userId, userId));

  return (
    <div className="page-fade flex flex-col items-center text-center pt-6 sm:pt-12 pb-12 px-4">
      <div className="max-w-md w-full space-y-6">
        <div className="space-y-3 flex flex-col items-center">
          {/* Hero mark above the heading. dark:invert keeps the dark
              monochrome glyph legible against the dark-mode surface. */}
          <Image
            src="/held-logo.png"
            alt="Held"
            width={96}
            height={96}
            priority
            className="w-20 h-20 sm:w-24 sm:h-24 object-contain dark:invert"
          />
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            Ready when you are.
          </h1>
          <p className="text-sm text-muted-foreground">
            One tap to start. Held captures the meeting, then ships the
            answer — decisions, action items, open questions, next step.
          </p>
        </div>

        <Recorder />

        {n > 0 && (
          <Link
            href="/app/meetings"
            className="tap-target inline-flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            ← Previous meetings ({n})
          </Link>
        )}
      </div>
    </div>
  );
}

import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function LandingPage() {
  const { userId } = await auth();
  if (userId) redirect("/app");

  return (
    <main className="page-fade relative flex-1 flex flex-col items-center justify-center px-6 py-12 overflow-hidden">
      {/* Soft indigo glow — radial blooms from the top and a faint hint
          bottom-right. Sits behind the content; pointer-events-none so it
          never intercepts clicks. The colors come from the brand token so
          they auto-shift when the user toggles dark mode. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 0%, color-mix(in srgb, var(--brand) 14%, transparent), transparent 70%), radial-gradient(40% 40% at 100% 100%, color-mix(in srgb, var(--brand) 10%, transparent), transparent 60%)",
        }}
      />
      <div className="max-w-xl text-center space-y-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand/10 text-brand text-sm font-medium">
          <span className="w-2 h-2 rounded-full bg-brand" />
          Every meeting, held for you
        </div>
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-foreground">
          Held.
        </h1>
        <p className="text-base sm:text-lg text-muted-foreground">
          One tap to capture. One card to read. Decisions, action items, open
          questions, and a single next step &mdash; without a transcript in
          the way.
        </p>
        <div className="flex items-center justify-center gap-3 pt-2">
          <Link
            href="/sign-in"
            className="tap-target inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-brand text-brand-foreground font-medium hover:bg-brand-hover transition-colors"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="tap-target inline-flex items-center justify-center px-5 py-2.5 rounded-lg border border-border text-foreground font-medium hover:bg-foreground/5 transition-colors"
          >
            Create account
          </Link>
        </div>
      </div>
    </main>
  );
}

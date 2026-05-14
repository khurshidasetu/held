/**
 * Auth shim while Clerk is disabled.
 *
 * Every request shares the same `"local"` user ID. This means there is
 * effectively a single account; anyone hitting the dev server sees the
 * same meetings and can record/delete on its behalf. Acceptable for local
 * development; **not** safe to deploy as-is.
 *
 * To re-enable real Clerk auth:
 *   1. Restore `web/proxy.ts` with `clerkMiddleware()` + the public-route
 *      matcher (see git history before this commit).
 *   2. Wrap `app/layout.tsx`'s `<html>` in `<ClerkProvider>` again and
 *      restore the `<UserButton />` in `components/Header.tsx`.
 *   3. Re-add the `/sign-in` and `/sign-up` route folders.
 *   4. Replace the body of `getCurrentUserId()` below with:
 *        const { auth } = await import("@clerk/nextjs/server");
 *        const { userId } = await auth();
 *        return userId; // null when unauthenticated — handle in callers
 */

const LOCAL_USER_ID = "local";

/**
 * Returns the current user's ID. Currently always `"local"`; never null.
 *
 * Callers that previously redirected to `/sign-in` on a null user can drop
 * that check — it will never trigger.
 */
export async function getCurrentUserId(): Promise<string> {
  return LOCAL_USER_ID;
}

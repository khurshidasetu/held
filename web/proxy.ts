// Next.js 16 renamed `middleware.ts` to `proxy.ts`. This runs on the Node.js
// runtime (not Edge) and is the standard place to gate routes with Clerk.
//
// See: node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  // Internal worker callback — authenticated with INTERNAL_WORKER_SECRET,
  // not a Clerk session.
  "/api/meetings/(.*)/process",
  // Local-storage signed-URL endpoint — the HMAC token IS the auth, so
  // we don't gate it on a Clerk session. The diarization service and
  // <audio> tags both fetch it directly.
  "/api/storage/(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and any file with an extension.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};

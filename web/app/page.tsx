import { redirect } from "next/navigation";

// With Clerk auth removed, there's no useful split between a landing page
// and the app shell — every visitor is the same "local" user. Skip the
// marketing surface and drop straight into the capture screen.
export default function RootIndexRedirect() {
  redirect("/app");
}

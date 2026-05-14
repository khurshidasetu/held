/**
 * Smoke test for the local storage driver. Run with:
 *   npx tsx scripts/test-storage.ts
 *
 * It writes a tiny synthetic "audio" file via the storage module, asks for
 * a signed URL, hits the URL through the running dev server (must be on
 * localhost:3000), and confirms the bytes round-trip.
 */
import { uploadBuffer, getPresignedGetUrl, audioKey } from "../lib/storage";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local" });

async function main() {
  const meetingId = `smoke-${Date.now()}`;
  const key = audioKey(meetingId, "webm");
  const payload = Buffer.from("MINUTELY_STORAGE_SMOKE_TEST_BYTES_v1", "utf8");

  console.log(`→ writing ${payload.byteLength} bytes to key:`, key);
  await uploadBuffer({
    key,
    body: payload,
    contentType: "audio/webm",
  });

  const url = await getPresignedGetUrl(key, 30);
  console.log(`→ signed URL:`, url);

  console.log(`→ fetching back through the route handler…`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET failed: ${res.status} ${await res.text()}`);
  }
  const got = Buffer.from(await res.arrayBuffer());

  if (got.equals(payload)) {
    console.log(`✓ bytes match (${got.byteLength} bytes), content-type=${res.headers.get("content-type")}`);
  } else {
    throw new Error(`✗ byte mismatch! got ${got.toString()}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

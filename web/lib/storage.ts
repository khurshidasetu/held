/**
 * Pluggable storage layer.
 *
 * Backends:
 *   - "local"  → writes under LOCAL_STORAGE_DIR (default web/storage). Reads go
 *                through GET /api/storage/[...key] with an HMAC-signed token,
 *                so the diarization service (different port) and the browser
 *                can both fetch the URL without a Clerk session. The token is
 *                the auth.
 *   - "s3"     → original AWS S3 implementation, presigned GETs.
 *
 * The export surface (`uploadBuffer`, `getPresignedGetUrl`, `audioKey`,
 * `speakerSampleKey`) is identical for both, so callers don't care which
 * backend is active.
 *
 * Switch via STORAGE_DRIVER env var (default "local" for low-friction dev).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

// ── Common key helpers (backend-agnostic) ─────────────────────────────

export function audioKey(meetingId: string, ext: string): string {
  return `meetings/${meetingId}/audio.${ext.replace(/^\./, "")}`;
}

export function speakerSampleKey(meetingId: string, n: number): string {
  return `speaker-samples/${meetingId}/speaker_${n}.mp3`;
}

// ── Driver-dispatching API ────────────────────────────────────────────

type Body = PutObjectCommandInput["Body"];

export async function uploadBuffer(args: {
  key: string;
  body: Body;
  contentType: string;
  cacheControl?: string;
}): Promise<void> {
  if (env.storage.driver === "local") return localUpload(args);
  return s3Upload(args);
}

export async function getPresignedGetUrl(
  key: string,
  expiresInSeconds = 3600
): Promise<string> {
  if (env.storage.driver === "local") return localSignedUrl(key, expiresInSeconds);
  return s3SignedUrl(key, expiresInSeconds);
}

// ── Local filesystem driver ───────────────────────────────────────────

function safeJoin(rootAbs: string, relKey: string): string {
  // Reject `..`, absolute paths, NUL bytes — the key must stay inside root.
  if (relKey.includes("\0")) throw new Error("Invalid key");
  const normalized = path.normalize(relKey);
  if (
    normalized.startsWith("..") ||
    path.isAbsolute(normalized) ||
    normalized.split(path.sep).includes("..")
  ) {
    throw new Error(`Refusing to access key outside storage root: ${relKey}`);
  }
  return path.join(rootAbs, normalized);
}

async function localUpload({
  key,
  body,
}: {
  key: string;
  body: Body;
}): Promise<void> {
  const root = env.storage.localDir;
  const dest = safeJoin(root, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const buf = await toBuffer(body);
  await fs.writeFile(dest, buf);
}

function localSignedUrl(key: string, expiresInSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const sig = signLocalKey(key, exp);
  // Encode the key as a path. The route handler stitches the segments back
  // together; encodeURI keeps slashes but escapes spaces / unicode.
  const encodedKey = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${env.storage.localBaseUrl}/api/storage/${encodedKey}?exp=${exp}&sig=${sig}`;
}

export function signLocalKey(key: string, exp: number): string {
  // HMAC-SHA256 over "<key>:<exp>" with the dedicated sign secret. Truncated
  // to 32 hex chars (128 bits) — plenty for a short-lived token, and keeps
  // URLs reasonably short.
  return createHmac("sha256", env.storage.localSignSecret)
    .update(`${key}:${exp}`)
    .digest("hex")
    .slice(0, 32);
}

export function verifyLocalSignature(
  key: string,
  exp: number,
  givenSig: string
): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const expected = signLocalKey(key, exp);
  if (expected.length !== givenSig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(givenSig));
  } catch {
    return false;
  }
}

export async function localReadStream(key: string): Promise<{
  buffer: Buffer;
  contentType: string;
} | null> {
  const root = env.storage.localDir;
  let abs: string;
  try {
    abs = safeJoin(root, key);
  } catch {
    return null;
  }
  try {
    const buf = await fs.readFile(abs);
    return { buffer: buf, contentType: guessContentType(key) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function guessContentType(key: string): string {
  const ext = path.extname(key).toLowerCase();
  switch (ext) {
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
    case ".m4a":
      return "audio/mp4";
    case ".webm":
      return "audio/webm";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

// ── S3 driver (unchanged behaviour from the old lib/s3.ts) ────────────

let _s3: S3Client | undefined;
function s3(): S3Client {
  return (_s3 ??= new S3Client({
    region: env.aws.region,
    credentials: {
      accessKeyId: env.aws.accessKeyId,
      secretAccessKey: env.aws.secretAccessKey,
    },
  }));
}

async function s3Upload({
  key,
  body,
  contentType,
  cacheControl,
}: {
  key: string;
  body: Body;
  contentType: string;
  cacheControl?: string;
}): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.aws.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    })
  );
}

async function s3SignedUrl(
  key: string,
  expiresInSeconds: number
): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: env.aws.bucket, Key: key }),
    { expiresIn: expiresInSeconds }
  );
}

// ── Misc ──────────────────────────────────────────────────────────────

async function toBuffer(body: Body): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body && typeof (body as Blob).arrayBuffer === "function") {
    return Buffer.from(await (body as Blob).arrayBuffer());
  }
  throw new Error("Unsupported body type for local storage upload");
}

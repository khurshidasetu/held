import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

// Lazy client + bucket — see lib/anthropic.ts for why we don't evaluate env
// at module load.
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

function bucket(): string {
  return env.aws.bucket;
}

/**
 * Upload an in-memory buffer to S3 at the given key.
 */
export async function uploadBuffer({
  key,
  body,
  contentType,
  cacheControl,
}: {
  key: string;
  body: PutObjectCommandInput["Body"];
  contentType: string;
  cacheControl?: string;
}): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    })
  );
}

/**
 * Return a presigned GET URL valid for `expiresInSeconds` (default 1 hour).
 *
 * We never expose the raw bucket — all reads go through presigned URLs so the
 * bucket can remain private.
 */
export async function getPresignedGetUrl(
  key: string,
  expiresInSeconds = 3600
): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: expiresInSeconds }
  );
}

/**
 * Build the S3 object key for a meeting's primary audio file.
 */
export function audioKey(meetingId: string, ext: string): string {
  return `meetings/${meetingId}/audio.${ext.replace(/^\./, "")}`;
}

/**
 * Build the S3 object key for a speaker's sample audio clip.
 */
export function speakerSampleKey(meetingId: string, n: number): string {
  return `speaker-samples/${meetingId}/speaker_${n}.mp3`;
}

/**
 * GET /api/storage/<key>?exp=<unix-seconds>&sig=<hmac-hex>
 *
 * Only used when STORAGE_DRIVER=local. Acts as a stand-in for an S3 presigned
 * URL: anyone holding a non-expired, valid signature can fetch the file. No
 * Clerk session required (the token IS the auth), which lets both the
 * browser (no Clerk in audio tag fetches anyway) and the FastAPI diarization
 * service hit it.
 */
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { localReadStream, verifyLocalSignature } from "@/lib/storage";

export const runtime = "nodejs";

type Context = { params: Promise<{ key: string[] }> };

export async function GET(request: Request, ctx: Context) {
  if (env.storage.driver !== "local") {
    return NextResponse.json(
      { error: "Local storage endpoint disabled (STORAGE_DRIVER is not 'local')" },
      { status: 404 }
    );
  }

  const { key: keyParts } = await ctx.params;
  const key = keyParts.map(decodeURIComponent).join("/");

  const url = new URL(request.url);
  const expRaw = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!expRaw || !sig) {
    return new NextResponse("Missing exp/sig", { status: 400 });
  }
  const exp = Number(expRaw);
  if (!verifyLocalSignature(key, exp, sig)) {
    return new NextResponse("Invalid or expired token", { status: 403 });
  }

  const file = await localReadStream(key);
  if (!file) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(file.buffer), {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.buffer.byteLength),
      // Same as a presigned S3 GET — private, never cache.
      "Cache-Control": "private, no-store",
    },
  });
}

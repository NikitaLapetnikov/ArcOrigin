import { NextRequest, NextResponse } from "next/server";
import {
  authorizeMetadataUpload,
  calculateMetadataCommitment,
  MetadataUploadError,
  normalizeUploadedImage,
  publishTokenMetadata,
  sha256Hex,
  validateImage,
} from "@/lib/server/metadata-upload";
import { isSameOriginRequest, readLimitedBytes, requestClientKey } from "@/lib/server/request-security";
import { TokenMetadataValidationError, validateTokenMetadataInput, type TokenMetadataInput } from "@/lib/token-metadata";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_MULTIPART_BYTES = 2_250_000;

function field(form: FormData, name: string) {
  const value = form.get(name);
  if (typeof value !== "string") throw new MetadataUploadError(`${name} is required.`);
  return value;
}

export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) throw new MetadataUploadError("Cross-origin upload requests are not allowed.", 403);
    let uploadBody: Uint8Array<ArrayBuffer>;
    try {
      uploadBody = await readLimitedBytes(request, MAX_MULTIPART_BYTES);
    } catch {
      throw new MetadataUploadError("Metadata upload request is too large.", 413);
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
      throw new MetadataUploadError("Metadata upload must use multipart form data.", 415);
    }
    const form = await new Response(uploadBody, {
      headers: { "Content-Type": contentType },
    }).formData();
    const input = validateTokenMetadataInput({
      name: field(form, "name"),
      symbol: field(form, "symbol"),
      description: field(form, "description"),
      website: field(form, "website"),
      x: field(form, "x"),
      telegram: field(form, "telegram"),
    } satisfies TokenMetadataInput);
    const imageEntry = form.get("image");
    const image = imageEntry instanceof File && imageEntry.size > 0 ? imageEntry : null;
    const imageBytes = image ? new Uint8Array(await image.arrayBuffer()) : null;
    validateImage(image, imageBytes);
    const imageSha256 = imageBytes ? sha256Hex(imageBytes) : "";
    const commitment = calculateMetadataCommitment(input, imageSha256);
    const creator = await authorizeMetadataUpload({
      nonce: field(form, "nonce"),
      address: field(form, "address"),
      commitment,
      signature: field(form, "signature"),
      clientKey: requestClientKey(request),
    });
    const normalizedImage = imageBytes ? await normalizeUploadedImage(imageBytes) : null;
    const result = await publishTokenMetadata({ input, creator, image: normalizedImage });
    if (result.metadataURI.length > 512) throw new MetadataUploadError("Generated metadata URI exceeds the contract limit.", 500);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof MetadataUploadError ? error.status : 400;
    const message = error instanceof MetadataUploadError || error instanceof TokenMetadataValidationError
      ? error.message
      : "Token metadata could not be uploaded.";
    return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}

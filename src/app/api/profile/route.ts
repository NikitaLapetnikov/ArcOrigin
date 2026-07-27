import { NextRequest, NextResponse } from "next/server";
import {
  authorizeProfileUpdate,
  normalizeProfileAvatar,
  profileCommitment,
  profileImageHash,
  ProfileError,
  saveWalletProfile,
} from "@/lib/server/profile-store";
import { isSameOriginRequest, readLimitedBytes, requestClientKey } from "@/lib/server/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_PROFILE_BYTES = 500_000;

function field(form: FormData, name: string) {
  const value = form.get(name);
  if (typeof value !== "string") throw new ProfileError(`${name} is required.`);
  return value;
}

export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) throw new ProfileError("Cross-origin profile requests are not allowed.", 403);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new ProfileError("Profile update must use multipart form data.", 415);
    const body = await readLimitedBytes(request, MAX_PROFILE_BYTES).catch(() => {
      throw new ProfileError("Profile update is too large.", 413);
    });
    const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
    const username = field(form, "username");
    const removeAvatar = field(form, "removeAvatar") === "true";
    const imageEntry = form.get("image");
    const image = imageEntry instanceof File && imageEntry.size > 0 ? imageEntry : null;
    const imageBytes = image ? new Uint8Array(await image.arrayBuffer()) : null;
    const submittedImageHash = field(form, "imageHash");
    const imageHash = profileImageHash(imageBytes);
    if (submittedImageHash.toLowerCase() !== imageHash.toLowerCase()) throw new ProfileError("Avatar changed after signing.", 401);
    const commitment = profileCommitment(username, imageHash, removeAvatar);
    const address = await authorizeProfileUpdate({
      nonce: field(form, "nonce"),
      address: field(form, "address"),
      commitment,
      signature: field(form, "signature"),
      clientKey: requestClientKey(request),
    });
    const avatar = await normalizeProfileAvatar(image, imageBytes);
    const profile = await saveWalletProfile({ address, username, avatar, removeAvatar });
    return NextResponse.json({ profile }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof ProfileError ? error.status : 400;
    return NextResponse.json(
      { error: error instanceof ProfileError ? error.message : "Profile could not be updated." },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}

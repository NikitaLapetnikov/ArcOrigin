export const TOKEN_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const TOKEN_IMAGE_INPUT_MAX_BYTES = 8 * 1024 * 1024;
export const TOKEN_URL_MAX_LENGTH = 200;
export const TOKEN_DESCRIPTION_MAX_CHARACTERS = 2_000;
export const TOKEN_DESCRIPTION_MAX_BYTES = 8_000;

export type TokenMetadataInput = {
  name: string;
  symbol: string;
  description: string;
  website: string;
  x: string;
  telegram: string;
};

export class TokenMetadataValidationError extends Error {}

function isPublicHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
  return true;
}

export function normalizeWebsiteUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > TOKEN_URL_MAX_LENGTH) throw new TokenMetadataValidationError("Website URL is too long.");

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new TokenMetadataValidationError("Enter a valid website address.");
  }
  if (!['http:', 'https:'].includes(url.protocol) || !isPublicHostname(url.hostname) || url.username || url.password) {
    throw new TokenMetadataValidationError("Website must be a public HTTP or HTTPS address.");
  }
  url.hash = "";
  return url.toString();
}

export function normalizeXUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > TOKEN_URL_MAX_LENGTH) throw new TokenMetadataValidationError("X profile is too long.");

  const handleCandidate = trimmed.replace(/^@/, "");
  if (/^[A-Za-z0-9_]{1,15}$/.test(handleCandidate)) return `https://x.com/${handleCandidate}`;

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new TokenMetadataValidationError("Enter a valid X profile or @handle.");
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const handle = url.pathname.split("/").filter(Boolean)[0] ?? "";
  if (!['x.com', 'twitter.com'].includes(host) || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    throw new TokenMetadataValidationError("Enter an x.com profile or @handle.");
  }
  return `https://x.com/${handle}`;
}

export function normalizeTelegramUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > TOKEN_URL_MAX_LENGTH) throw new TokenMetadataValidationError("Telegram link is too long.");
  const handleCandidate = trimmed.replace(/^@/, "");
  if (/^[A-Za-z0-9_]{5,32}$/.test(handleCandidate)) return `https://t.me/${handleCandidate}`;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new TokenMetadataValidationError("Enter a valid Telegram community or @handle.");
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const handle = url.pathname.split("/").filter(Boolean)[0] ?? "";
  if (!["t.me", "telegram.me"].includes(host) || !/^[A-Za-z0-9_]{5,32}$/.test(handle)) {
    throw new TokenMetadataValidationError("Enter a t.me community link or @handle.");
  }
  return `https://t.me/${handle}`;
}

export function validateTokenMetadataInput(input: TokenMetadataInput): TokenMetadataInput {
  const name = input.name.trim();
  const symbol = input.symbol.trim().toUpperCase();
  const description = input.description.trim();
  const nameBytes = new TextEncoder().encode(name).byteLength;
  if (name.length < 2 || nameBytes > 64 || /[\u0000-\u001F\u007F]/u.test(name)) {
    throw new TokenMetadataValidationError("Token name must be 2–64 UTF-8 bytes with no control characters.");
  }
  if (!/^[A-Za-z0-9]{2,10}$/.test(symbol)) throw new TokenMetadataValidationError("Ticker must be 2–10 letters or numbers.");
  if (!description) throw new TokenMetadataValidationError("Description is required.");
  if (
    description.length > TOKEN_DESCRIPTION_MAX_CHARACTERS
    || new TextEncoder().encode(description).byteLength > TOKEN_DESCRIPTION_MAX_BYTES
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(description)
  ) {
    throw new TokenMetadataValidationError(
      `Description must be at most ${TOKEN_DESCRIPTION_MAX_CHARACTERS.toLocaleString("en-US")} characters with no control characters.`,
    );
  }
  return {
    name,
    symbol,
    description,
    website: normalizeWebsiteUrl(input.website),
    x: normalizeXUrl(input.x),
    telegram: normalizeTelegramUrl(input.telegram),
  };
}

export function canonicalMetadataCommitment(input: TokenMetadataInput, imageSha256: string) {
  return JSON.stringify({
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    website: input.website,
    x: input.x,
    telegram: input.telegram,
    imageSha256,
  });
}

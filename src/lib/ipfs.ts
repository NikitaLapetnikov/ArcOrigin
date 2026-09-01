const IPFS_PATH_PATTERN = /^([A-Za-z0-9]{40,120})(\/[^?#]*)?$/;

export function parseIpfsPath(uri: string) {
  const normalized = uri.trim().replace(/^ipfs:\/\/(?:ipfs\/)?/, "");
  const match = normalized.match(IPFS_PATH_PATTERN);
  if (!match || match[2]?.split("/").includes("..")) return null;
  return `${match[1]}${match[2] ?? ""}`;
}

export function ipfsMediaURL(uri: string) {
  const path = parseIpfsPath(uri);
  if (!path) return "";
  return `/api/media/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function normalizeIpfsImageURL(uri?: string) {
  if (!uri) return undefined;
  if (uri.startsWith("/api/media/")) return uri;
  const gatewayPrefixes = [
    "https://gateway.pinata.cloud/ipfs/",
    "https://ipfs.io/ipfs/",
    "https://dweb.link/ipfs/",
  ];
  const prefix = gatewayPrefixes.find((candidate) => uri.startsWith(candidate));
  return prefix ? ipfsMediaURL(uri.slice(prefix.length)) || uri : ipfsMediaURL(uri) || uri;
}

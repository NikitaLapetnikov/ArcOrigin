import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";
function httpsOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

const configuredArcConnectSources = [
  process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL ?? "",
  ...(process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_FALLBACK_URLS ?? "").split(","),
  process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_API_URL ?? "",
].map((value) => httpsOrigin(value.trim())).filter((value): value is string => Boolean(value));
const arcConnectSources = [...new Set([
  "https://rpc.arc-scan.org",
  "https://ac-rpc.theleak.cx",
  "https://arc-mainnet-rpc.baracat.meme",
  "https://arc-mainnet.cloud.blockscout.com",
  "https://api.arc-scan.org",
  ...configuredArcConnectSources,
])];
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self' https://app.safe.global https://*.safe.global",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://ipfs.io https://gateway.pinata.cloud",
  "font-src 'self' data:",
  `connect-src 'self' ${arcConnectSources.join(" ")} https://ipfs.io https://gateway.pinata.cloud${isDevelopment ? " ws:" : ""}`,
  "worker-src 'self' blob:",
  ...(!isDevelopment ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      {
        source: "/api/onchain/rpc",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type" },
          { key: "Access-Control-Allow-Methods", value: "POST, OPTIONS" },
          { key: "Access-Control-Max-Age", value: "86400" },
        ],
      },
    ];
  },
};

export default nextConfig;

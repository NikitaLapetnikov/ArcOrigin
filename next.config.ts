import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";
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
  `connect-src 'self' https://rpc.drpc.testnet.arc.network https://rpc.blockdaemon.testnet.arc.network https://rpc.quicknode.testnet.arc.network https://rpc.testnet.arc.network https://testnet.arcscan.app https://ipfs.io https://gateway.pinata.cloud${isDevelopment ? " ws:" : ""}`,
  "worker-src 'self' blob:",
  ...(!isDevelopment ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "Access-Control-Allow-Methods", value: "GET" },
        { key: "Access-Control-Allow-Headers", value: "X-Requested-With, content-type, Authorization" },
      ],
    }];
  },
};

export default nextConfig;

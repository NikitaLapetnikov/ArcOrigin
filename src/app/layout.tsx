import type { Metadata, Viewport } from "next";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import { Providers } from "./providers";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";

// Railway's edge cache can otherwise retain prerendered HTML across deployments.
// A short ISR window keeps the static shell fast while ensuring releases propagate.
export const revalidate = 60;

export const metadata: Metadata = {
  metadataBase: new URL("https://arcorigin.xyz"),
  title: { default: "ArcOrigin — Launch and discover tokens on Arc", template: "%s · ArcOrigin" },
  description: "Launch, discover, and trade Arc-native tokens through transparent USDC bonding curves on Arc Testnet.",
  icons: {
    icon: [{ url: "/icon.png", type: "image/png", sizes: "192x192" }],
    apple: [{ url: "/apple-icon.png", type: "image/png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    siteName: "ArcOrigin",
    title: "ArcOrigin — Launch and discover tokens on Arc",
    description: "Launch and trade Arc-native tokens through transparent USDC bonding curves.",
    images: [{
      url: "/brand/arcorigin-x-header-premium-master-v2.png",
      width: 2172,
      height: 724,
      alt: "ArcOrigin",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ArcOrigin — Launch and discover tokens on Arc",
    description: "Launch and trade Arc-native tokens through transparent USDC bonding curves.",
    images: ["/brand/arcorigin-x-header-premium-master-v2.png"],
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#060811",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en"><body className="antialiased">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Providers><Header /><main id="main-content">{children}</main><Footer /></Providers>
    </body></html>
  );
}

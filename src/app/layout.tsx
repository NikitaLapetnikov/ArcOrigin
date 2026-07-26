import type { Metadata, Viewport } from "next";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/header";

// Railway's edge cache can otherwise retain prerendered HTML across deployments.
// A short ISR window keeps the static shell fast while ensuring releases propagate.
export const revalidate = 60;

export const metadata: Metadata = {
  title: { default: "ArcOrigin — Launch and discover tokens on Arc", template: "%s · ArcOrigin" },
  description: "USDC bonding curves, transparent fees, verified creator history, real-time charts, and risk labels for Arc-native tokens.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#060811",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en"><body className="antialiased">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Providers><Header /><main id="main-content">{children}</main></Providers>
    </body></html>
  );
}

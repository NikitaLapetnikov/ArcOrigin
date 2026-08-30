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
  description: "Launch, discover, and trade Arc-native tokens in permanently locked USDC pools.",
  manifest: "/manifest.json",
  icons: {
    icon: [{ url: "/brand/arcorigin-favicon-v2.png", type: "image/png", sizes: "192x192" }],
    apple: [{ url: "/brand/arcorigin-apple-icon-v2.png", type: "image/png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    siteName: "ArcOrigin",
    title: "ArcOrigin — Launch and discover tokens on Arc",
    description: "Launch and trade Arc-native tokens in permanently locked USDC pools.",
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
    description: "Launch and trade Arc-native tokens in permanently locked USDC pools.",
    images: ["/brand/arcorigin-x-header-premium-master-v2.png"],
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: "#060811",
};

const themeBootstrap = `(()=>{try{const saved=localStorage.getItem("arcorigin-theme");const theme=saved==="light"||saved==="dark"?saved:matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";localStorage.setItem("arcorigin-theme",theme);document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=theme==="light"?"#f0f7fc":"#060811"}catch{document.documentElement.dataset.theme="dark";document.documentElement.style.colorScheme="dark"}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeBootstrap }} /></head><body className="antialiased">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Providers><Header /><main id="main-content">{children}</main><Footer /></Providers>
    </body></html>
  );
}

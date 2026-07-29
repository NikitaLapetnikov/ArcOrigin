import type { Metadata } from "next";
import { LegalDocument, type LegalSection } from "@/components/legal-document";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How ArcOrigin handles wallet, blockchain, token metadata, and technical information.",
};

const sections: LegalSection[] = [
  {
    title: "About this policy",
    content: <><p>This policy explains how the ArcOrigin interface handles information when you browse markets, connect a wallet, create a token, submit a trade, or use related features.</p><p>ArcOrigin is noncustodial. We do not hold private keys, recovery phrases, or assets, and we cannot sign transactions for you.</p></>,
  },
  {
    title: "Information processed",
    content: <><p>Depending on how you use ArcOrigin, the interface may process:</p><ul><li>Public wallet addresses, transaction hashes, token balances, contract interactions, and other public blockchain records.</li><li>Token names, symbols, descriptions, images, websites, and social links that you choose to publish.</li><li>Browser and device information needed for security, reliability, and diagnostics, such as request timing, browser type, and IP address handled by hosting or infrastructure providers.</li><li>Local preferences such as wallet connection state and your watchlist.</li></ul></>,
  },
  {
    title: "How information is used",
    content: <ul><li>Display launches, markets, wallet positions, trades, holders, and contract state.</li><li>Prepare transaction requests for your wallet and refresh confirmed onchain results.</li><li>Store and resolve public token metadata.</li><li>Protect the interface, diagnose errors, enforce reasonable limits, and improve performance.</li></ul>,
  },
  {
    title: "Public blockchain and IPFS",
    content: <><p>Arc networks and IPFS are public systems. Wallet addresses, transactions, token metadata, and uploaded images may remain public indefinitely and can be copied by independent services.</p><p>ArcOrigin cannot edit, reverse, hide, or delete records confirmed on a public blockchain or content retained by distributed storage providers.</p></>,
  },
  {
    title: "Service providers",
    content: <p>ArcOrigin relies on independent services for wallet connectivity, Arc RPC access, block exploration, hosting, caching, and IPFS storage or gateways. Those providers process information under their own policies and may be unavailable without notice. ArcOrigin does not sell personal information or use it for targeted advertising.</p>,
  },
  {
    title: "Browser storage",
    content: <p>The interface uses browser storage for preferences, confirmed launch caches, watchlists, and wallet session support. You can clear this data in your browser, but saved preferences and faster cached views will be lost.</p>,
  },
  {
    title: "Security and retention",
    content: <><p>We use reasonable safeguards for systems under our control, but no wallet, smart contract, network, website, or storage system is completely secure.</p><p>Never send anyone your private key or recovery phrase. Technical records may be retained only as needed for operation, security, troubleshooting, and legal obligations. Public blockchain and IPFS records are outside our retention control.</p></>,
  },
  {
    title: "Your choices",
    content: <ul><li>Browse public pages without connecting a wallet.</li><li>Disconnect your wallet and clear local browser data.</li><li>Avoid including personal information in public token metadata.</li><li>Manage permissions directly in your wallet.</li></ul>,
  },
  {
    title: "Children and changes",
    content: <><p>ArcOrigin is not directed to children under 18. We may update this policy as the interface, infrastructure, or legal requirements change. The effective date identifies the current version.</p></>,
  },
  {
    title: "Contact",
    content: <p>For privacy questions, contact the project through the official X account at <a href="https://x.com/arcorigin_" target="_blank" rel="noreferrer">@arcorigin_</a>. Do not include private keys, recovery phrases, or passwords.</p>,
  },
];

export default function PrivacyPage() {
  return <LegalDocument
    label="ArcOrigin legal"
    title="Privacy Policy"
    summary="How ArcOrigin handles wallet, blockchain, token metadata, browser, and technical information."
    effectiveDate="July 27, 2026"
    sections={sections}
  />;
}

import type { Metadata } from "next";
import { LegalDocument, type LegalSection } from "@/components/legal-document";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "The responsibilities and risks that apply when using the ArcOrigin interface.",
};

const sections: LegalSection[] = [
  {
    title: "Agreement",
    content: <p>These Terms govern your access to and use of the ArcOrigin website and interface. By using the interface, connecting a wallet, or submitting a transaction, you confirm that you understand and accept these Terms and the Privacy Policy. If you do not agree, do not use ArcOrigin.</p>,
  },
  {
    title: "About ArcOrigin",
    content: <><p>ArcOrigin is a software interface for discovering tokens and interacting with wallets, Arc networks, smart contracts, public market data, and distributed storage.</p><p>ArcOrigin is not a bank, broker, exchange, custodian, investment adviser, fiduciary, or financial institution.</p></>,
  },
  {
    title: "Eligibility",
    content: <p>You must be at least 18 years old, have legal capacity to accept these Terms, and use ArcOrigin only where lawful. You are responsible for complying with applicable financial, sanctions, tax, intellectual-property, and other laws.</p>,
  },
  {
    title: "Wallets and transactions",
    content: <><p>ArcOrigin is noncustodial. Every transaction is initiated and authorized through your wallet. We cannot recover a wallet, reverse a transaction, cancel an approval, guarantee settlement, or restore lost assets.</p><ul><li>Protect your wallet, device, keys, and recovery phrase.</li><li>Review the network, contract address, amount, fees, slippage, and approvals before signing.</li><li>Accept responsibility for transactions authorized through your wallet.</li></ul></>,
  },
  {
    title: "Token launches and content",
    content: <><p>You are responsible for every token and piece of metadata you create or submit, including its name, symbol, description, image, website, and social links. You confirm that the content is lawful, accurate, not misleading, and that you have permission to publish it.</p><p>Creation or listing does not mean ArcOrigin reviewed, endorsed, or guaranteed a token. Public blockchain and IPFS content may be permanent.</p></>,
  },
  {
    title: "Trading and market data",
    content: <><p>Quotes, charts, balances, market capitalization, holder counts, fees, and transaction outcomes may be delayed or differ from final execution. Confirm important values in your wallet and onchain.</p><p>Tokens may be volatile, illiquid, experimental, malicious, or worthless. ArcOrigin does not guarantee graduation, liquidity, token value, counterparties, or an ability to exit.</p></>,
  },
  {
    title: "Fees and taxes",
    content: <p>Transactions may include network fees, protocol fees, price impact, slippage, and third-party costs. Current amounts are shown in the interface or transaction request before signing and can change through onchain governance. You are responsible for any taxes or reporting obligations.</p>,
  },
  {
    title: "Network and technical risk",
    content: <><p>ArcOrigin operates on Arc mainnet. Mainnet assets can be volatile or lose all value, contracts may change through new deployments, and network data may be unavailable.</p><p>Smart contracts, wallets, RPC providers, indexers, explorers, storage systems, and browsers can fail, contain defects, or behave unexpectedly. Use only assets you can afford to lose.</p></>,
  },
  {
    title: "Acceptable use",
    content: <ul><li>Do not violate law or the rights of others.</li><li>Do not submit fraudulent, abusive, illegal, malicious, or infringing token content.</li><li>Do not distribute malware, exploit vulnerabilities, evade limits, manipulate displayed data, or overload infrastructure.</li><li>Do not use ArcOrigin for theft, fraud, market manipulation, money laundering, or other unlawful activity.</li></ul>,
  },
  {
    title: "Third-party services",
    content: <p>Wallets, Arc networks, smart contracts, explorers, RPC providers, IPFS gateways, and external websites are independent services. ArcOrigin does not control or guarantee their security, availability, accuracy, or privacy practices. Their own terms may apply.</p>,
  },
  {
    title: "No warranties",
    content: <p>ArcOrigin is provided on an “as is” and “as available” basis to the maximum extent permitted by law. We do not guarantee uninterrupted access, error-free software, accurate market data, secure contracts, or any financial result. Nothing in the interface is financial, legal, accounting, or tax advice.</p>,
  },
  {
    title: "Limitation and changes",
    content: <><p>To the maximum extent permitted by law, ArcOrigin and its contributors are not liable for indirect, incidental, special, consequential, or financial losses arising from wallets, transactions, tokens, smart contracts, networks, third parties, or use of the interface.</p><p>Access may be restricted for security, legal, or operational reasons. These Terms may change as the project develops; the effective date identifies the current version.</p></>,
  },
  {
    title: "Contact",
    content: <p>Questions about these Terms can be sent through the official X account at <a href="https://x.com/arcorigin_" target="_blank" rel="noreferrer">@arcorigin_</a>.</p>,
  },
];

export default function TermsPage() {
  return <LegalDocument
    label="ArcOrigin legal"
    title="Terms of Use"
    summary="The conditions, responsibilities, and risks that apply when you access or use the ArcOrigin interface."
    effectiveDate="July 27, 2026"
    sections={sections}
  />;
}

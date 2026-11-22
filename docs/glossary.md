# Glossary of Terms

This glossary defines key concepts used in the Mobile Money ↔ Stellar Bridge platform, including African mobile money terminology, Stellar ecosystem standards, and financial technology concepts.

## African Mobile Money

**Anchor**
A financial entity that integrates with the Stellar network to enable deposits and withdrawals of fiat currencies (e.g., USD, EUR) or other real-world assets. Anchors provide the on/off-ramp between traditional finance and blockchain. In the Mobile Money Bridge, anchors facilitate the connection between mobile money providers and Stellar.
- Reference: [SEP-24 - Federated Asset Standards](https://developers.stellar.org/docs/learn/interacting-with-stellar/anchor-servers)

**M-Pesa**
A mobile money service operated by Safaricom in Kenya, Tanzania, and other East African countries. M-Pesa enables users to send money, pay bills, and access financial services via USSD or mobile app.

**MoMo (Mobile Money)**
A generic term for financial services accessed via mobile phones. Includes MTN MoMo, Airtel Money, Orange Money, and other providers. MoMo services enable users without bank accounts to participate in the financial system.

**MSISDN**
Mobile Station International Subscriber Directory Number. A unique identifier for a mobile phone number in the E.164 format (e.g., +256701234567). Used to identify users in mobile money systems.

**MTN MoMo**
Mobile money service operated by MTN Group across Africa (Uganda, Cameroon, Ghana, Côte d'Ivoire, Zambia, and others). Allows users to send money, pay merchants, and buy airtime.

**Orange Money**
Mobile money service operated by Orange Telecom in African countries including Senegal, Madagascar, Guinea, and Côte d'Ivoire. Provides payment, remittance, and financial services.

**STK Push**
Acronym for "SIM Toolkit Push." A protocol for proactively sending USSD prompts or payment requests to a user's phone without requiring the user to dial a code first. Used in mobile money for merchant-initiated payments (e.g., paying for goods at a store).
- Example: A merchant's POS system sends an STK push to debit a customer's mobile money account directly.

**USSD**
Unstructured Supplementary Service Data. A protocol that allows users to interact with services via text-based menus on any phone (smartphone or basic phone). Common for mobile money: dial a code like `*142*1#` to check balance or send money. No internet connection required.

---

## Stellar Ecosystem

**Stellar**
A decentralized network for issuing assets and processing payments. Stellar uses a federated consensus model with anchors, validators, and endpoints. It enables fast, low-cost cross-border transactions and is the blockchain foundation of the Mobile Money Bridge.
- Website: [stellar.org](https://stellar.org)
- Documentation: [Stellar Developers](https://developers.stellar.org)

**XLM (Lumens)**
The native cryptocurrency of the Stellar network. Used for transaction fees and as a medium of exchange. Every Stellar account must hold a minimum balance in XLM (~0.5 XLM for account creation and operations).

**USDC**
USD Coin, a USD-backed stablecoin issued by Circle on multiple blockchains, including Stellar. Represents 1:1 value with the US dollar and is used for value storage and cross-border transfers.

**Soroban**
Stellar's smart contract platform. Enables complex logic on Stellar (escrow, HTLCs, conditional payments, decentralized finance). The Mobile Money Bridge may use Soroban for escrow-based settlement and advanced payment logic.
- Reference: [Soroban Documentation](https://developers.stellar.org/docs/learn/soroban)

**Horizon**
The REST API for the Stellar network. Allows applications to submit transactions, query account balances, stream payments, and monitor ledger state. All Stellar interactions in the Mobile Money Bridge flow through Horizon.
- Documentation: [Horizon API Reference](https://developers.stellar.org/api/introduction/authentication)

---

## Stellar Ecosystem Protocol (SEP) Standards

The SEP standards define how anchors and applications interact with Stellar for asset issuance, deposits, withdrawals, and compliance.

**SEP-1 (Stellar.toml)**
A protocol for anchors to publish metadata about their assets, servers, and compliance policies in a `stellar.toml` file. Used by wallets and applications to discover anchor details.
- Reference: [SEP-1 Standard](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0001.md)

**SEP-8 (Regulated Assets)**
Standard for enforcing approval rules on asset transfers (e.g., KYC/AML checks before allowing a transfer). The Mobile Money Bridge may use SEP-8 to enforce compliance requirements.
- Reference: [SEP-8 Standard](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0008.md)

**SEP-10 (Stellar Web Authentication)**
Protocol for authenticating users and applications using Stellar keypairs. Clients sign a challenge to prove they control an account without sharing private keys. Used for secure API access.
- Reference: [SEP-10 Standard](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)

**SEP-12 (KYC/AML API)**
Standard API for collecting and managing KYC (Know Your Customer) and AML (Anti-Money Laundering) information from users. Anchors use SEP-12 to verify customer identities before processing transactions.
- Reference: [SEP-12 Standard](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md)

**SEP-24 (Federated Web Authentication)**
Standard for hosted deposit and withdrawal flows. Anchors provide a web interface where users deposit/withdraw fiat via IBAN, card, or other methods. Users authenticate via SEP-10.
- Reference: [SEP-24 Standard](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md)

**SEP-31 (Cross-Border Payments)**
Standard for receiving cross-border payments on behalf of users without requiring them to hold Stellar accounts. The receiver's anchor handles the final payout. Enables seamless remittances.
- Reference: [SEP-31 Standard](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md)

**SEP-38 (Pricing Information)**
Standard API for exchanging real-time pricing and rate information between anchors. Used for quotes and firm pricing before settlement.
- Reference: [SEP-38 Standard](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md)

---

## Financial & Compliance Terms

**AML**
Anti-Money Laundering. Regulatory compliance measures to detect and prevent financial crimes. The Mobile Money Bridge implements AML screening to block sanctioned entities and report suspicious activity.

**KYC**
Know Your Customer. Regulatory requirement for financial institutions to verify customer identities and assess risk. The Mobile Money Bridge performs KYC to comply with banking regulations.

**Transaction Settlement**
The process of transferring value between accounts. In the Mobile Money Bridge, a cross-border transaction settles when:
1. Funds are debited from the sender's mobile money account.
2. Tokens are issued on the Stellar network.
3. Tokens are redeemed on the destination Stellar account.
4. Funds are credited to the receiver's mobile money account.

**Escrow**
A mechanism to hold funds or assets temporarily until conditions are met. Stellar and Soroban support escrow for conditional payments (e.g., "release funds only after delivery confirmation").

**HTLC (Hash Time-Locked Contract)**
A cryptographic contract ensuring atomic, trustless payment across blockchains or networks. Both parties lock funds and reveal a secret to unlock payment. Stellar supports HTLCs via transactions.

**Fee Engine**
The system that calculates transaction fees based on merchant tier, transaction amount, asset type, and destination country. Fees are transparent and competitive compared to traditional remittance services.

**Double-Entry Ledger**
An accounting system recording every transaction in two accounts (debit and credit) to ensure accuracy and detect fraud. Used by the Mobile Money Bridge to audit all financial flows.

---

## Platform Architecture Terms

**API Versioning**
The process of maintaining backward compatibility as the API evolves. The Mobile Money Bridge supports multiple API versions (e.g., `/v1/`, `/v2/`) to avoid breaking existing integrations.

**GraphQL**
A query language for APIs that allows clients to request only the data they need. The Mobile Money Bridge offers a GraphQL endpoint alongside REST for flexible queries.

**WebSocket**
A protocol for real-time, bidirectional communication between client and server. The Mobile Money Bridge uses WebSockets to stream live transaction updates to connected clients.

**Rate Limiting**
A mechanism to control the number of API requests per client to prevent abuse and ensure fair resource allocation. The Mobile Money Bridge implements tiered rate limits based on merchant subscription level (Starter: 60 rpm, Pro: 300 rpm, Enterprise: 1000 rpm).

**Job Queue**
An asynchronous task processing system (e.g., BullMQ with Redis) that defers long-running operations like batch payouts, reconciliation, and fraud checks. Decouples request handling from processing.

**Redis**
An in-memory data store used for caching, rate limiting, job queues, and real-time messaging. Critical for horizontal scaling and performance.

---

## Cross-Border Payment Terms

**Remittance**
Money sent from one person to another across borders, typically by a migrant worker sending funds to family in their home country. The Mobile Money Bridge enables fast, low-cost remittances.

**Nostro Account**
A bank account held by a financial institution in another country to facilitate cross-border payments (e.g., a Cameroonian bank's USD account in the US).

**Correspondent Bank**
A bank that provides services on behalf of another bank in a different country, enabling cross-border transactions.

---

## Security Terms

**Audit Logging**
Recording of all administrative actions (balance adjustments, fee updates, permissions changes) for compliance and security investigations. The Mobile Money Bridge implements tamper-evident audit logs using SHA-256 hash chaining.

**Hash Chaining**
A cryptographic technique where each record includes a SHA-256 hash of the previous record. Makes unauthorized database tampering immediately detectable because hashes will no longer match.

**API Key Tier**
Subscription levels with different rate limits and features. Starter tier allows 60 requests per minute; Pro allows 300; Enterprise allows 1000.

---

For additional resources:
- [Stellar Developers Portal](https://developers.stellar.org)
- [SEP Standards Overview](https://github.com/stellar/stellar-protocol/tree/master/ecosystem)
- [Mobile Money Industry Overview](https://www.gsma.com/mobilefordevelopment/research/mobile-money)

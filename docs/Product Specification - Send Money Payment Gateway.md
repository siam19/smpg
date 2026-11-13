# Product Specification: Send Money Payment Gateway (SMPG)

## Overview
The **Send Money Payment Gateway (SMPG)** is a hybrid, multi-tenant payment infrastructure designed to solve the high barrier-to-entry for merchants wanting to accept bKash and Nagad payments. Instead of requiring trade licenses and corporate bank accounts, SMPG leverages personal "Send Money" transactions. 

It uses a unique **Human-in-the-Loop Telegram Verification** system for rapid transaction approval, a **publishable NPM SDK** for custom developers, and a **Hosted Checkout Page** tailored for seamless integration with e-commerce platforms like Shopify.

---

## Core Architecture & Components

The system is designed as a monorepo consisting of three main pillars:

### 1. The Core Engine (Cloudflare Worker + D1 Database)
The highly scalable, serverless backend that orchestrates the entire platform.
* **Multi-Tenant Database:** Powered by Cloudflare D1 (SQLite) to store merchant profiles, API keys, and transaction states (`PENDING`, `APPROVED`, `REJECTED`).
* **Telegram Bot Webhook:** Receives all commands and button taps from the central Telegram bot.
* **Outbound Webhook Dispatcher:** Securely fires cryptographically signed POST requests to merchant servers when payments are resolved.

### 2. The Merchant Experience (Central Telegram Bot)
A dashboard-less merchant management system natively built into Telegram.
* **Frictionless Onboarding:** Merchants register by simply starting the bot (`/start`).
* **Wallet Management:** Commands like `/set_bkash [number]` and `/set_nagad [number]` configure their receiving accounts.
* **One-Tap Approvals:** When a customer submits a TrxID, the merchant receives a rich Telegram message with inline **[ Approve ]** and **[ Reject ]** buttons.

### 3. The Integrations (SDK & Shopify App)
* **NPM SDK (`send-money-payment-gateway`):** A lightweight, zero-dependency library for custom web apps (Next.js, SvelteKit, Express) to create payments and verify incoming webhook signatures.
* **Hosted Checkout Page (Shopify Plugin):** A standalone, brandable offsite payment page that bridges Shopify's Payment Apps API with the SMPG backend.

---

## Key Features

### Branded Hosted Checkout
For Shopify merchants (or merchants using payment links), SMPG provides a sleek, conversion-optimized checkout UI.
* **Custom Branding:** During onboarding, merchants can set their `Store Name` and upload a `Profile Picture` / `Logo`.
* **Dynamic Display:** The checkout page prominently features the merchant's branding to build customer trust.
* **Clear Instructions:** Dynamically displays the merchant's bKash/Nagad number, the exact `৳` amount to send, and an input field for the `TrxID`.
* **Real-Time UI Updates:** Once the customer submits the TrxID, the page enters a polling/WebSocket state. The moment the merchant taps "Approve" in Telegram, the customer's screen instantly updates to a "Success" state and redirects them back to the store.

### Secure Webhooks & SDK
* **HMAC Signatures:** Every webhook dispatched to a merchant contains an `x-smpg-signature` header.
* **SDK Verification:** The `send-money-payment-gateway` package provides a simple `gateway.webhooks.constructEvent()` method to ensure the payload hasn't been tampered with by malicious actors trying to fake approvals.
* **Double-Tap Prevention:** Telegram inline buttons are immediately replaced with a static text badge (e.g., *Approved by @username*) upon the first tap.

### Shopify Payments App Compatibility
* Functions as an Offsite Payments App Extension.
* Accepts the checkout redirect from Shopify containing the `paymentSessionId`.
* Utilizes the Shopify GraphQL API (`paymentSessionResolve`) behind the scenes upon Telegram approval to securely finalize the order in the Shopify admin panel.

### Future-Proofed for Automation (SMS Fallback)
The architecture is designed to support a hybrid model in the future:
1. **Tier 1 (Manual):** The current Telegram human-in-the-loop flow.
2. **Tier 2 (Automated):** An optional companion Android app that reads incoming SMS messages from bKash/Nagad. If the SMS TrxID and amount perfectly match a `PENDING` transaction in the database, the Cloudflare Worker auto-approves the payment, skips the Telegram buttons (sending a read-only receipt instead), and instantly resolves the Shopify/Webhook checkout.


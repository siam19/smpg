# Sprint 5: Hosted Checkout Frontend (`apps/checkout`)

> **Status**: Planned  
> **Reference**: [SMPG Master Plan - Section 3 (Customer Experience), Section 12 (Hosted Checkout Page)](../../SMPG_Plan.md)

---

## Sprint Objectives
Build and deploy the hosted customer checkout web application in `apps/checkout` using SvelteKit, Tailwind CSS, and Cloudflare Pages/Workers adapter. It delivers a fast, mobile-first, optimistic checkout experience adhering strictly to SMPG's asynchronous verification model.

---

## Deliverables & Scope

1. **Architecture & Styling**:
   - Modern, mobile-first single-page checkout built with SvelteKit.
   - Dynamic merchant theming: Injects merchant's `brand_color`, `store_name`, and store logo (served from R2 `BUCKET`).
   - English language interface with crisp typography and high visual trust.

2. **Method Selection Screen**:
   - Displays payment options: Cash on Delivery (COD), bKash Send Money, Nagad Send Money.
   - Automatically disables methods that lack active wallet capacity or are turned off by the merchant.
   - Progressively enhanced: COD provides instant confirmation and redirection.

3. **bKash & Nagad Payment Flow**:
   - Assigned Wallet Card:
     - Displays assigned personal wallet number with an instant 1-tap "Copy" button.
     - Displays exact payable amount in BDT (`৳`) with a 1-tap "Copy" button.
     - Visual 3-step Send Money visual walkthrough.
   - Submission Form:
     - Sender phone number input (`01XXXXXXXXX`) with live validation.
     - Transaction ID input labeled `TrxID` for bKash and `TxnID` for Nagad.
     - Honeypot anti-bot hidden field.
     - Action button styled with merchant's brand color.

4. **Optimistic Completion & Asynchronous Redirect**:
   - Instant transition to thank-you card upon submission:
     - *"Thank you! We received your payment details. The seller will verify them shortly."*
     - Clear expectation setting: explains verification happens in the background (minutes to hours).
   - 3-second redirect back to merchant's `success_url?payment_id=...&status=submitted`.

5. **State-Aware Session Resumption**:
   - Re-opening `/c/:id` adapts dynamically to current payment status:
     - `SUBMITTED`: Displays "Payment is being verified" with submitted TrxID and link back to storefront.
     - `PAID`: Displays "Payment Verified & Paid ✅" with link back to order receipt.
     - `REJECTED`: Displays polite notice and resubmission form (allowing up to 3 submission attempts).
     - `EXPIRED`: Displays session expired notice, offering late submission if within the 24-hour grace window.
     - `CANCELLED`: Displays payment cancelled notification.

6. **Edge Deployment**:
   - Cloudflare deployment via `@sveltejs/adapter-cloudflare`.
   - Connects directly to `apps/core` public endpoints (`GET /c/:id/data`, `POST /c/:id/method`, `POST /c/:id/submit`).

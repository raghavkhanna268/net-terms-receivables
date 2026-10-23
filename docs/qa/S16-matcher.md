# S16 Acceptance Test Plan: Payment matcher for Indian bank transfers

**Status:** S16 is not built yet. As of `main` the schema has `Payment`, `Match`, and `PayerAlias` tables but no matching algorithm exists. Everything below is **required behaviour**. The plan is grounded in:
- `prisma/schema.prisma` and `20261022000001_s5_data_model`:
  - `Payment` with `narration`, `payerText`, `utr`, `rail` (NEFT/RTGS/IMPS/UPI/CLG), `amount`, `valueDate`, `status`
  - `Match` with `paymentId`, `invoiceId`, `amount`, `score` (0-100), `reasons` (JSON), `state` (suggested/confirmed/pushed)
  - `PayerAlias` maps normalised `payerKey` tokens to `BuyerAccount`
  - `Invoice` with `outstanding`, `name`, `orderId`, `buyerAccountId`
- S14/S15 bank parsers: HDFC, ICICI statement parsing extracts credits with rail, UTR, narration
- `docs/scopes.md`: email and displayName available for S16 matching when `CUSTOMER_PII_FIELDS=1`

> **Assumptions (no spec in repo):**
> - Matching is triggered when a BankImport is processed or on-demand for unmatched payments
> - Match confidence scores: 100 = exact ref match, 80-99 = amount+buyer match, 50-79 = partial/ambiguous, <50 = low confidence
> - No auto-apply below a confidence threshold (default 80). Suggested matches require merchant confirmation.
> - Synthetic fixtures are marked so they're excluded from real bank validation tests

## 1. Purpose
This plan verifies that:
- Indian bank transfer payments (NEFT/RTGS/IMPS/UPI) are correctly matched to open invoices
- exact reference matches, amount+buyer matches, and ambiguous matches are handled appropriately
- overpayments, duplicates, and partial matches are detected and flagged
- low-confidence matches are never auto-applied
- synthetic test data is clearly marked and excluded from production validation

## 2. Preconditions and fixtures (synthetic data only)
- **Shop:** `qa-shop-a.myshopify.com` with `currency='INR'`.
- **Buyer accounts:**
  - C1: `BuyerAccount(kind=COMPANY, name='QA Wholesale Co', companyLocationId=gid://shopify/CompanyLocation/7101)`
  - T1: `BuyerAccount(kind=TAGGED_CUSTOMER, name='QA Buyer', customerId=gid://shopify/Customer/8001)`
- **Invoices:**
  - INV-001: `name='#1001'`, `total=₹10,000`, `outstanding=₹10,000`, `buyerAccountId=C1`
  - INV-002: `name='#1002'`, `total=₹25,000`, `outstanding=₹25,000`, `buyerAccountId=C1`
  - INV-003: `name='#1003'`, `total=₹10,000`, `outstanding=₹10,000`, `buyerAccountId=T1`
- **Payer aliases:** `PayerAlias(buyerAccountId=C1, payerKey='qa wholesale co')`
- **Bank imports:** Synthetic `BankImport` rows with `bank='hdfc'` or `bank='icici'`
- **Payments:** Synthetic `Payment` rows parsed from test bank statements with various narrations:
  - P1: NEFT with narration `"NEFT/QA WHOLESALE CO/INV1001/UTR123456"`, amount=₹10,000
  - P2: RTGS with narration `"RTGS/PAYMENT FROM QA WHOLESALE/REF1002"`, amount=₹25,000
  - P3: IMPS with narration `"IMPS/JOHN DOE/MISC"`, amount=₹10,000 (ambiguous)
  - P4: UPI with narration `"UPI/qa.buyer@upi/1003"`, amount=₹10,000

## 3. Test cases

### A. Exact reference match
| # | Steps | Expected |
|---|---|---|
| S16-01 | Payment narration contains invoice name `"1001"` or `"#1001"`. Amount matches exactly. | Match score=100. `reasons` includes `{type:'invoice_ref', ref:'1001'}`. |
| S16-02 | Payment narration contains order name/number that maps to an Invoice. | Match score=100. `reasons` includes `{type:'order_ref'}`. |
| S16-03 | Payment UTR matches a previously-matched payment's UTR. | Flagged as potential duplicate. No new match created. |
| S16-04 | Payment has multiple invoice refs in narration (e.g., `"1001 1002"`). | Creates multiple suggested matches, one per invoice. Total amounts must not exceed payment. |

### B. Amount + buyer match
| # | Steps | Expected |
|---|---|---|
| S16-10 | Payment payer text matches `PayerAlias.payerKey`. Amount matches an open invoice exactly. | Match score=90. `reasons` includes `{type:'payer_alias', amount:'exact'}`. |
| S16-11 | Payment payer text matches buyer name (normalised). Amount matches. | Match score=85. `reasons` includes `{type:'buyer_name'}`. |
| S16-12 | Payment payer text matches `s8_tagged_customers.email` (when `CUSTOMER_PII_FIELDS=1`). | Match score=85. `reasons` includes `{type:'email_match'}`. |
| S16-13 | Payment payer text matches `s8_tagged_customers.display_name`. | Match score=80. `reasons` includes `{type:'display_name_match'}`. |
| S16-14 | Amount matches but buyer cannot be identified. | Match score=60 (amount-only). Flagged as ambiguous. |

### C. Ambiguous and partial matches
| # | Steps | Expected |
|---|---|---|
| S16-20 | Payment amount matches multiple open invoices from different buyers. | Multiple suggested matches, each with `score<80`. None auto-applied. |
| S16-21 | Payment amount partially matches an invoice (e.g., ₹8,000 payment for ₹10,000 invoice). | Suggested as partial match. `reasons` includes `{type:'partial', invoiceOutstanding:10000, paymentAmount:8000}`. |
| S16-22 | Buyer has two open invoices with the same amount. | Both are suggested. Merchant must confirm which. |
| S16-23 | Payment narration is generic (e.g., `"NEFT/PAYMENT"`), no identifiable refs. | Match score<50. Remains unmatched until merchant action. |

### D. Overpayment
| # | Steps | Expected |
|---|---|---|
| S16-30 | Payment=₹12,000 for invoice with `outstanding=₹10,000`. | Match suggested for ₹10,000. Overpayment of ₹2,000 flagged. `reasons` includes `{type:'overpayment', excess:2000}`. |
| S16-31 | Merchant confirms overpayment match. | Invoice marked paid. Excess tracked as credit or refundable. Document the model. |

### E. Duplicate detection
| # | Steps | Expected |
|---|---|---|
| S16-40 | Same UTR imported twice (e.g., re-upload of statement). | Second import skips the payment (`Payment.utr` unique constraint). No duplicate `Match`. |
| S16-41 | Same payment details but different UTR (bank correction). | Flagged for review. Not auto-matched to avoid double-counting. |
| S16-42 | Payment already has a confirmed Match. Matcher runs again. | Skipped. Matcher is idempotent for confirmed payments. |

### F. No auto-apply on low confidence
| # | Steps | Expected |
|---|---|---|
| S16-50 | Match with `score=79`. | `state=suggested`. NOT auto-applied. Requires merchant confirmation. |
| S16-51 | Match with `score=80` (threshold). | Behaviour depends on config. Document whether 80 auto-applies or requires confirmation. |
| S16-52 | Match with `score=100` (exact ref match). | Auto-apply allowed (configurable). If enabled, `state=confirmed` and `outstanding` reduced. |
| S16-53 | Auto-apply disabled globally. Score=100. | `state=suggested`. Merchant must confirm. |

### G. Rail-specific parsing
| # | Steps | Expected |
|---|---|---|
| S16-60 | NEFT payment: narration format `"NEFT/<sender>/<ref>/<utr>"`. | Rail detected as `NEFT`. Sender and ref extracted. |
| S16-61 | RTGS payment: narration format `"RTGS/<sender>/REF<number>"`. | Rail detected as `RTGS`. Ref extracted. |
| S16-62 | IMPS payment: narration format `"IMPS/<sender>/<ref>"`. | Rail detected as `IMPS`. |
| S16-63 | UPI payment: narration format `"UPI/<vpa>/<ref>"`. | Rail detected as `UPI`. VPA may help identify buyer. |
| S16-64 | CLG (cheque clearing): narration varies by bank. | Rail detected as `CLG`. Parsing may be less reliable. |

### H. Synthetic fixture marking
| # | Steps | Expected |
|---|---|---|
| S16-70 | Synthetic test payments have a marker (e.g., `utr` prefix `SYNTH-` or tag in narration). | Clearly identifiable as synthetic. |
| S16-71 | Production validation tests filter out synthetic fixtures. | Real bank export validation excludes `SYNTH-` UTRs. |
| S16-72 | Synthetic fixtures do not pollute production metrics. | Dashboard counts exclude synthetic data. |

### I. Real bank export validation (open done-criterion)
| # | Steps | Expected |
|---|---|---|
| S16-80 | Parse actual HDFC bank statement export (redacted PII). | All credits extracted. Rails identified. UTRs parsed. |
| S16-81 | Parse actual ICICI bank statement export (redacted PII). | All credits extracted. Format differences handled. |
| S16-82 | Parse statement with edge cases (special characters, Unicode, long narrations). | No crashes. Truncation handled gracefully. |
| S16-83 | **Open done-criterion:** Real bank statement validation requires manual verification against actual exports when available. | Document which exports have been validated. |

## 4. Data-minimization checks
Only **Level 1 plus email and name** may be stored. **Phone and address are a fail.**
- **DM-1:** `Payment.narration` and `Payment.payerText` may contain payer names (PII-bearing per schema comment). These are **not** customer data but bank statement data. Ensure no customer phone or address is extracted or stored.
- **DM-2:** Match `reasons` JSON contains only match types, amounts, and normalised tokens. No raw customer PII.
- **DM-3:** `s8_tagged_customers.email` and `display_name` are used for matching ONLY when `CUSTOMER_PII_FIELDS=1`. When off, these columns are NULL and not queried.
- **DM-4:** Matcher logs print payment IDs, invoice IDs, scores, and match types. No narration text, no payer names, no customer data.
- **DM-5:** Global schema scan finds no phone or address columns.

## 5. Vitest automation hints
- Unit-test `parseNarration(narration, rail)` with `it.each` over NEFT/RTGS/IMPS/UPI/CLG formats.
- Unit-test `calculateMatchScore(payment, invoice, aliases)` with fixture pairs.
- Integration: seed BankImport, Payments, Invoices, run matcher, assert Match rows and scores.
- For duplicate detection: insert same UTR twice, assert unique constraint or skip logic.
- For ambiguous matches: create invoices with same amount, different buyers, assert multiple suggestions.
- Mock `CUSTOMER_PII_FIELDS` env to test email/name matching vs. disabled.

## 6. Done criteria
- [ ] S16-01 through S16-04 pass. Exact reference matches score 100 and are correctly identified.
- [ ] S16-10 through S16-14 pass. Amount+buyer matches use payer aliases, names, email, displayName.
- [ ] S16-20 through S16-23 pass. Ambiguous and partial matches are flagged, not auto-applied.
- [ ] S16-30 through S16-31 pass. Overpayments are detected and the excess handling is documented.
- [ ] S16-40 through S16-42 pass. Duplicates are detected. Matcher is idempotent.
- [ ] S16-50 through S16-53 pass. Low-confidence matches require confirmation. Threshold is documented.
- [ ] S16-60 through S16-64 pass. Rail-specific parsing works for NEFT/RTGS/IMPS/UPI/CLG.
- [ ] S16-70 through S16-72 pass. Synthetic fixtures are clearly marked and filtered.
- [ ] S16-80 through S16-83: Real bank export validation remains an open done-criterion until actual exports are tested.
- [ ] DM-1 through DM-5 pass.

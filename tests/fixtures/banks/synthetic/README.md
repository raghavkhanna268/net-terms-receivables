# Synthetic Bank Statement Fixtures

This directory contains **SYNTHETIC** test fixtures for bank statement parsing.

## IMPORTANT: All data is synthetic

**NONE of this data is from real bank statements.** All account numbers, names, UTRs, VPAs, and transaction details are fabricated for testing purposes only.

## Public Format Documentation Sources

These fixtures are built from **publicly available** bank statement format documentation:

### HDFC Bank Format

| Source | URL | Information Used |
|--------|-----|------------------|
| TieOut HDFC Documentation | https://www.tieout.in/banks/hdfc/ | Column structure, date formats, header patterns |
| CleanStatement HDFC | https://www.cleanstatement.in/hdfc-bank-statement-to-excel | Column layout, narration wrapping |
| StatementConverter HDFC | https://statementconverter.io/blog/convert-hdfc-bank-statement-to-excel | Format details, Value Dt column |

**HDFC Retail columns:** Date | Narration | Chq./Ref.No. | Value Dt | Withdrawal Amt. | Deposit Amt. | Closing Balance

**Date format:** DD/MM/YY or DD/MM/YYYY

### ICICI Bank Format

| Source | URL | Information Used |
|--------|-----|------------------|
| TieOut ICICI Documentation | https://www.tieout.in/banks/icici/ | Column structure, date formats, B/F row handling |
| Jemsky ICICI | https://jemsky.com/banks/icici | Multiple format variants, corporate vs retail |
| ICICI Bank Official | https://www.icici.bank.in/personal-banking/accounts/savings-account/statements | Statement download options |

**ICICI Retail columns:** S No. | Transaction Date | Cheque Number | Remarks | Withdrawal | Deposit | Balance

**Date format:** DD.MM.YYYY or DD-Mon-YYYY (corporate)

### SBI (State Bank of India) Format (UNVERIFIED)

| Source | URL | Information Used |
|--------|-----|------------------|
| TieOut SBI Documentation | https://www.tieout.in/banks/sbi/ | Column structure, date formats |
| CleanStatement SBI | https://www.cleanstatement.in/sbi-bank-statement-to-excel | Column layout |
| StatementConverter SBI | https://statementconverter.io/blog/convert-sbi-bank-statement-to-excel | Format details |

**SBI Retail columns (UNVERIFIED):** Txn Date | Value Date | Description | Ref No./Cheque No. | Debit | Credit | Balance

**Date format:** DD/MM/YYYY or DD MMM YYYY

**IMPORTANT:** SBI format is UNVERIFIED pending redacted real samples from the merchant.

### Axis Bank Format (UNVERIFIED)

| Source | URL | Information Used |
|--------|-----|------------------|
| TieOut Axis Documentation | https://www.tieout.in/banks/axis/ | Column structure, date formats |
| CleanStatement Axis | https://www.cleanstatement.in/axis-bank-statement-to-excel | Column layout |
| StatementConverter Axis | https://statementconverter.io/blog/convert-axis-bank-statement-to-excel | Format details |

**Axis Bank Retail columns (UNVERIFIED):** Tran Date | Chq No | Particulars | DR | CR | Balance

**Date format:** DD-MM-YYYY or DD/MM/YYYY

**IMPORTANT:** Axis format is UNVERIFIED pending redacted real samples from the merchant.

## UTR Format Documentation

UTR (Unique Transaction Reference) formats are based on RBI and bank documentation:

| Rail | Format | Example (Synthetic) |
|------|--------|---------------------|
| NEFT | `[A-Z]{4}N\d{11,17}` (bank code + N + digits) | SYNTN26296000001 |
| RTGS | `[A-Z]{4}R\d{11,17}` (bank code + R + digits) | SYNTR26296000001 |
| IMPS | 12 digits (RRN) | 123456789012 |
| UPI | 12 digits (RRN) | 987654321098 |

**Note:** ACH, NACH, and cheque numbers are NOT UTRs and are not used for deduplication.

## Fixture Files

### HDFC Fixtures
- `hdfc-retail-synthetic.csv` - Standard retail savings account format (SYNTHETIC)
- `hdfc-retail-synthetic.xlsx` - XLSX version of above (SYNTHETIC)
- `hdfc-malformed-synthetic.csv` - Malformed rows for error handling tests (SYNTHETIC)
- `hdfc-malformed-synthetic.xlsx` - XLSX version of above (SYNTHETIC)
- `hdfc-review-synthetic.csv` - **App Store reviewer file (FICTIONAL)** - Minimal statement with pinned parse/match behavior for reviewer demonstrations. Contains NEFT, UPI, IMPS credits and one debit. All data is entirely fictional.
- `hdfc-synthetic.xls` - **BIFF8 .xls** (SYNTHETIC, generated from value-free structural layout specs)
- `hdfc-synthetic.csv` - CSV twin of above with identical transactions (SYNTHETIC, generated)

### ICICI Fixtures
- `icici-retail-synthetic.csv` - Standard retail savings format (SYNTHETIC)
- `icici-retail-synthetic.xlsx` - XLSX version of above (SYNTHETIC)
- `icici-malformed-synthetic.csv` - Malformed rows for error handling tests (SYNTHETIC)
- `icici-malformed-synthetic.xlsx` - XLSX version of above (SYNTHETIC)
- `icici-synthetic.xls` - **BIFF8 .xls** (SYNTHETIC, generated from value-free structural layout specs)
- `icici-synthetic.csv` - CSV twin of above with identical transactions (SYNTHETIC, generated)

### SBI Fixtures (UNVERIFIED)
- `sbi-retail-synthetic.csv` - Standard retail savings format (SYNTHETIC, UNVERIFIED LAYOUT)
- `sbi-retail-synthetic.xlsx` - XLSX version of above (SYNTHETIC, UNVERIFIED LAYOUT)
- `sbi-malformed-synthetic.csv` - Malformed rows for error handling tests (SYNTHETIC, UNVERIFIED LAYOUT)
- `sbi-malformed-synthetic.xlsx` - XLSX version of above (SYNTHETIC, UNVERIFIED LAYOUT)

### Axis Bank Fixtures (UNVERIFIED)
- `axis-retail-synthetic.csv` - Standard retail savings format (SYNTHETIC, UNVERIFIED LAYOUT)
- `axis-retail-synthetic.xlsx` - XLSX version of above (SYNTHETIC, UNVERIFIED LAYOUT)
- `axis-malformed-synthetic.csv` - Malformed rows for error handling tests (SYNTHETIC, UNVERIFIED LAYOUT)
- `axis-malformed-synthetic.xlsx` - XLSX version of above (SYNTHETIC, UNVERIFIED LAYOUT)

### Unknown Format
- `unknown-bank-synthetic.csv` - Unknown bank format for detection tests (SYNTHETIC)

### XLSX Generation
XLSX fixtures are generated from CSV source files using `scripts/generate-xlsx-fixtures.ts`.
Run `npx tsx scripts/generate-xlsx-fixtures.ts` to regenerate them after modifying CSV sources.

### Real-Layout BIFF8 .xls Fixtures
The `*-synthetic.xls` and matching `*-synthetic.csv` files are generated from value-free structural layout specs; all values are fictional.
They reproduce the structural format of HDFC and ICICI .xls exports including:

**ICICI (`icici-synthetic.xls`):**
- 12-row preamble with merges (title, account info, filters)
- Header row at row 12 with Value Date BEFORE Transaction Date
- Column order: spacer | S No. | Value Date | Transaction Date | Cheque Number | Transaction Remarks | Withdrawal Amount(INR) | Deposit Amount(INR) | Balance(INR) | spacer
- All cells are TEXT (string) type with number format General
- 0.00 on non-applicable amount side (never blank)
- Narration overflow rows (col F only) for long narrations
- Legend footer block with no blank separator

**HDFC (`hdfc-synthetic.xls`):**
- Bank banner row, two-column preamble block (rows 4-17)
- Asterisk separator rows before/after header and after data
- Header row at row 20 with exact HDFC column names
- Mixed cell types: text for dates/narration/ref, NUMERIC for amounts
- Blank (no cell) on non-applicable amount side (not 0.00)
- Full footer: summary values row (numeric, no labels), Dr/Cr counts, generation line, end marker

**Features covered by both:**
- UPI credits and debits with various narration forms
- VPA with hyphen (7-segment HDFC form)
- VPA without @ (ICICI alphanumeric form)
- Ref ≠ 0000+RRN case (HDFC)
- 15-digit ref case (HDFC)
- Card/ATW debits (HDFC)
- CMS credits, ACH debits (ICICI)
- Interest credits
- Value Date ≠ Transaction/Date case
- Narration overflow rows (ICICI mid-data and last-txn edge case)

Generate with: `npx tsx scripts/fixtures/make-bank-xls.ts`

## Synthetic Data Generation Rules

All fixtures follow these rules to ensure data is obviously synthetic:

1. **Account Numbers**: All start with `00` followed by random digits
2. **Names**: Use obviously fake names with "SYNTHETIC" marker (e.g., "SYNTHETIC CORP PVT LTD")
3. **UTRs**: Use `SYNT` bank code prefix (e.g., `SYNTN26296000001`, `SYNTR26296000001`)
4. **VPAs**: Use `@synthetic` domain (e.g., `fakevendor@synthetic`)
5. **IFSCs**: Use `SYNT0` prefix (e.g., `SYNT0000001`)
6. **Dates**: Use 2026 to make it obviously non-historical
7. **Amounts**: Use round numbers that don't match any real transactions

## Validation Status

### REMAINING (Not Done)

- [ ] **Validate against real HDFC and ICICI exports** - Synthetic fixtures match public documentation, but minor variations in real exports (spacing, edge cases, header variations) may require adjustments after validation with actual bank statements.
- [ ] **Validate SBI layouts against redacted real samples** - SBI parser layout is UNVERIFIED and based solely on public documentation. Production validation required.
- [ ] **Validate Axis layouts against redacted real samples** - Axis parser layout is UNVERIFIED and based solely on public documentation. Production validation required.

The synthetic data accurately reflects the publicly documented column structure and date formats, but production validation is required before relying on this parser for real financial data.

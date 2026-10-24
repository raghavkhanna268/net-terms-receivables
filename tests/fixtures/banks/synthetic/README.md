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

### ICICI Fixtures
- `icici-retail-synthetic.csv` - Standard retail savings format (SYNTHETIC)
- `icici-retail-synthetic.xlsx` - XLSX version of above (SYNTHETIC)
- `icici-malformed-synthetic.csv` - Malformed rows for error handling tests (SYNTHETIC)
- `icici-malformed-synthetic.xlsx` - XLSX version of above (SYNTHETIC)

### Unknown Format
- `unknown-bank-synthetic.csv` - Unknown bank format for detection tests (SYNTHETIC)

### XLSX Generation
XLSX fixtures are generated from CSV source files using `scripts/generate-xlsx-fixtures.ts`.
Run `npx tsx scripts/generate-xlsx-fixtures.ts` to regenerate them after modifying CSV sources.

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

The synthetic data accurately reflects the publicly documented column structure and date formats, but production validation is required before relying on this parser for real financial data.

# Bank Statement Sample Request

This document specifies what redacted sample bank statements are needed to verify and improve our parsers.

## Overview

Our parsers currently handle bank statement exports from HDFC, ICICI, SBI, and Axis Bank. To verify and improve parser accuracy, we need redacted real-world samples that preserve the export structure while removing sensitive information.

## File Types Accepted

All parsers accept the following file types:
- **CSV** (.csv) — Plain text, comma-separated
- **XLS** (.xls) — Legacy Excel format (BIFF8)
- **XLSX** (.xlsx) — Modern Excel format

## Bank-Specific Requirements

### HDFC Bank

**Export source**: Any account statement export from HDFC net banking (retail or corporate portal). Exact export path/report name is unverified — use whatever CSV/XLS/XLSX export your net banking provides.

**Expected columns** (order may vary):

| Column | Keep Intact | Redaction |
|--------|-------------|-----------|
| Date / Txn Date | ✅ Yes | — |
| Narration / Transaction Description | Partial | See narration redaction below |
| Chq./Ref.No. / Cheque/Ref. No | ✅ Yes (structure only) | Preserve length and format |
| Value Dt / Value Date | ✅ Yes | — |
| Withdrawal Amt. / Debit Amount | ✅ Yes | — |
| Deposit Amt. / Credit Amount | ✅ Yes | — |
| Closing Balance / Balance | ✅ Yes | — |

### ICICI Bank

**Export source**: Any account statement export from ICICI net banking (retail or corporate portal). Exact export path/report name is unverified — use whatever CSV/XLS/XLSX export your net banking provides.

**Expected columns** (order may vary):

| Column | Keep Intact | Redaction |
|--------|-------------|-----------|
| S No. / Transaction ID | ✅ Yes | — |
| Transaction Date / Date | ✅ Yes | — |
| Cheque Number / Chq./Ref.No. | ✅ Yes (structure only) | Preserve length and format |
| Remarks / Particulars / Description | Partial | See narration redaction below |
| Withdrawal / Debit | ✅ Yes | — |
| Deposit / Credit | ✅ Yes | — |
| Balance | ✅ Yes | — |

### SBI (State Bank of India)

**Export source**: Any account statement export from SBI net banking. Exact export path/report name is unverified — use whatever CSV/XLS/XLSX export your net banking provides.

> ⚠️ **UNVERIFIED LAYOUT**: The SBI parser is based on publicly available documentation and has NOT been verified against real SBI statement exports.

**Expected columns** (order may vary):

| Column | Keep Intact | Redaction |
|--------|-------------|-----------|
| Txn Date / Transaction Date | ✅ Yes | — |
| Value Date | ✅ Yes | — |
| Description / Transaction Remarks | Partial | See narration redaction below |
| Ref No./Cheque No. | ✅ Yes (structure only) | Preserve length and format |
| Debit / Withdrawal | ✅ Yes | — |
| Credit / Deposit | ✅ Yes | — |
| Balance | ✅ Yes | — |

### Axis Bank

**Export source**: Any account statement export from Axis Bank net banking (retail or corporate portal). Exact export path/report name is unverified — use whatever CSV/XLS/XLSX export your net banking provides.

> ⚠️ **UNVERIFIED LAYOUT**: The Axis parser is based on publicly available documentation and has NOT been verified against real Axis Bank statement exports.

**Expected columns** (order may vary):

| Column | Keep Intact | Redaction |
|--------|-------------|-----------|
| Tran Date / Transaction Date | ✅ Yes | — |
| Value Date | ✅ Yes (if present) | — |
| Chq No / Chq./Ref.No. | ✅ Yes (structure only) | Preserve length and format |
| Particulars / Description | Partial | See narration redaction below |
| DR / Debit | ✅ Yes | — |
| CR / Credit | ✅ Yes | — |
| Balance | ✅ Yes | — |

## Narration / Description Redaction Rules

The narration field is critical for UTR extraction and payment rail detection. Redact as follows:

### What to KEEP intact
- **Rail prefix**: NEFT, RTGS, IMPS, UPI, ACH, CHEQUE indicators
- **UTR/RRN structure**: Preserve the exact length and alphanumeric pattern
  - NEFT: 4 letters + N + 11-17 digits (e.g., `HDFCN12345678901`)
  - RTGS: 4 letters + R + 11-17 digits (e.g., `ICICR12345678901`)
  - IMPS/UPI: 12-digit RRN (e.g., `999988887777`)
- **Transfer direction indicators**: CR, DR, IN, OUT, BY, TO

### What to REDACT
- **Remitter/beneficiary names**: Replace with same-length placeholder
  - `NEFT CR-ACME CORP LTD-INV001` → `NEFT CR-XXXX XXXX XXX-INV001`
- **Account numbers**: Mask all but last 4 digits
  - `1234567890123456` → `XXXXXXXXXXXX3456`
- **Free-text narrations**: Replace with same-shape placeholders
  - `Payment for invoice 12345` → `XXXXXXX XXX XXXXXXX 00000`
- **Customer IDs / User IDs**: Replace entirely
- **IFSC codes of counterparties**: May be redacted (optional)
- **Phone numbers / email addresses**: Replace entirely
- **Physical addresses**: Replace entirely

### Placeholder Guidelines
- Keep the same number of words and approximate word lengths
- Preserve any delimiters (hyphens, slashes, underscores)
- Keep numeric portions as zeros of the same length
- **Example transformations**:
  - `NEFT CR-RAJESH KUMAR-SALARY-SEP` → `NEFT CR-XXXXXX XXXXX-XXXXXX-XXX`
  - `UPI/999988887777/ABC TRADERS/PAY` → `UPI/999988887777/XXX XXXXXXX/XXX`
  - `IMPS-INWARD-9876543210-JOHN DOE` → `IMPS-INWARD-0000000000-XXXX XXX`

## Sample Requirements

### Recommended Row Count
- **20–50 rows** per sample file
- Include a mix of:
  - **Credits**: NEFT, RTGS, IMPS, UPI inward transfers
  - **Debits**: A few debit transactions (we skip these but need them for format validation)
  - **Different amounts**: Small (< ₹10,000) and large (> ₹1,00,000)
  - **Multiple dates**: Spanning at least 1 week

### Required Transaction Types
Each sample should include at least one of each:
- [ ] NEFT credit
- [ ] RTGS credit (if available)
- [ ] IMPS credit
- [ ] UPI credit
- [ ] At least 2 debit transactions

### Critical Preservation
1. **Column headers must be EXACTLY as exported** — do not rename, reorder, or translate
2. **Row structure must be unmodified** — maintain any header rows, summary rows, footers
3. **Date formats must be preserved** — dd/mm/yy, dd/mm/yyyy, dd-MMM-yyyy, etc.
4. **Amount formats must be preserved** — commas, decimal places, Cr/Dr suffixes

## Why Header and Layout Preservation Matters

Our parsers rely on:
1. **Header detection**: Specific column names to map data fields
2. **Footer detection**: Identifying summary/total rows to skip
3. **Continuation row detection**: Multi-line narrations that wrap
4. **Date format detection**: Bank-specific date patterns

Modifying the structure (even cosmetically) can cause parsing failures or misdetection.

## Sharing Instructions

⚠️ **DO NOT commit samples to the repository**

1. Share files privately via secure file sharing (Google Drive, Dropbox, etc.)
2. Name files clearly: `{bank}-{type}-redacted-sample.{ext}`
   - Example: `hdfc-retail-redacted-sample.csv`
   - Example: `icici-corporate-redacted-sample.xlsx`
3. Confirm the export source (net banking path if known)
4. Note any unusual formatting or variants you've encountered

## Questions?

If you're unsure about how to redact a specific field or whether a column is needed, ask before modifying. It's better to preserve uncertain fields than to over-redact and lose critical parsing signals.

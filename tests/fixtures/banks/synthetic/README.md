# Synthetic Bank Statement Fixtures

This directory contains **SYNTHETIC** test fixtures for bank statement parsing.

## IMPORTANT: All data is synthetic

**NONE of this data is from real bank statements.** All account numbers, names, UTRs, VPAs, and transaction details are fabricated for testing purposes only.

## Sources Used

These fixtures are built from **publicly documented** bank statement formats:

### HDFC Bank Format

Source documentation:
1. [TieOut HDFC Documentation](https://www.tieout.in/banks/hdfc/) - Column structure, date formats
2. [CleanStatement HDFC](https://www.cleanstatement.in/hdfc-bank-statement-to-excel) - Column layout
3. [StatementConverter HDFC](https://statementconverter.io/blog/convert-hdfc-bank-statement-to-excel) - Format details

HDFC Retail columns: Date | Narration | Chq./Ref.No. | Value Dt | Withdrawal Amt. | Deposit Amt. | Closing Balance
Date format: DD/MM/YY or DD/MM/YYYY

### ICICI Bank Format

Source documentation:
1. [TieOut ICICI Documentation](https://www.tieout.in/banks/icici/) - Column structure, date formats
2. [Jemsky ICICI](https://jemsky.com/banks/icici) - Multiple format variants
3. [ICICI Bank Official](https://www.icici.bank.in/personal-banking/accounts/savings-account/statements) - Statement options

ICICI Retail columns: S No. | Transaction Date | Cheque Number | Remarks | Withdrawal | Deposit | Balance
Date format: DD.MM.YYYY or DD-Mon-YYYY (corporate)

## Fixture Files

### HDFC Fixtures
- `hdfc-retail-synthetic.csv` - Standard retail savings account format (synthetic data)
- `hdfc-enet-synthetic.csv` - ENet/corporate format variant (synthetic data)
- `hdfc-malformed-synthetic.csv` - Malformed rows for error handling tests (synthetic data)

### ICICI Fixtures
- `icici-retail-synthetic.csv` - Standard retail savings format (synthetic data)
- `icici-corporate-synthetic.csv` - Corporate detailed statement format (synthetic data)
- `icici-malformed-synthetic.csv` - Malformed rows for error handling tests (synthetic data)

### Unknown Format
- `unknown-bank-synthetic.csv` - Unknown bank format for detection tests (synthetic data)

## Synthetic Data Generation Rules

1. **Account Numbers**: All start with `00` followed by random digits
2. **Names**: Use obviously fake names like "SYNTHETIC CORP PVT LTD", "FAKE VENDOR LTD"
3. **UTRs**: Use `SYNT` prefix (e.g., `SYNT202610150001`)
4. **VPAs**: Use `@synthetic` domain (e.g., `fakeuser@synthetic`)
5. **IFSCs**: Use `SYNT0` prefix (e.g., `SYNT0000001`)
6. **Dates**: Use 2026 to make it obviously non-historical
7. **Amounts**: Use round numbers that don't match any real transactions

## Usage in Tests

```typescript
import { readFileSync } from 'fs';
import { parseBankStatement } from '~/lib/banks';

// Load synthetic fixture
const fixture = readFileSync('tests/fixtures/banks/synthetic/hdfc-retail-synthetic.csv');

// Parse and test
const result = await parseBankStatement(new File([fixture], 'hdfc-retail-synthetic.csv'));
expect(result.detection.bank).toBe('HDFC');
```

## Validation Status

⚠️ **REMAINING**: These synthetic fixtures need to be validated against real HDFC and ICICI bank exports to ensure the format exactly matches production data.

The synthetic data accurately reflects the publicly documented column structure and date formats, but minor variations in real exports (spacing, edge cases) may require adjustments.

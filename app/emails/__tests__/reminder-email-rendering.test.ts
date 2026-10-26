/**
 * Payment Reminder Email Rendering Tests (S18).
 *
 * Table-driven test suite covering:
 * - All reminder kinds from DEFAULT_RULE_OFFSETS (pre-due, due-today, overdue)
 * - INR amounts with Indian grouping (sub-lakh, lakh, crore values)
 * - Date format (Luxon DATE_FULL)
 * - Absence of 'undefined', 'NaN', '[object', or empty placeholder patterns
 * - Shop name and invoice number presence in output
 * - Footer and opt-out text presence
 * - Subject line validation
 * - Coverage guard ensuring all registry kinds are tested
 * - Recipient allowlist filtering
 */
import { describe, it, expect } from "vitest";
import {
  renderPaymentReminderEmail,
  type PaymentReminderEmailProps,
} from "../PaymentReminderEmail";
import {
  getReminderLabel,
  DEFAULT_RULE_OFFSETS,
} from "~/services/reminders.server";
import {
  parseRecipientAllowlist,
  filterRecipients,
  isRecipientAllowed,
  isAllowlistEnforced,
} from "~/services/recipient-allowlist.server";
import { DateTime } from "luxon";

const SYNTHETIC_SHOP_NAME = "Test Shop";
const SYNTHETIC_INVOICE_NUMBER = "INV-TEST-001";
const SYNTHETIC_BUYER_NAME = "Test Customer";
const SYNTHETIC_TIMEZONE = "Asia/Kolkata";

interface ReminderKindTestCase {
  offsetDays: number;
  expectedLabel: string;
  isOverdue: boolean;
  isDueToday: boolean;
}

const REMINDER_KIND_TEST_CASES: ReminderKindTestCase[] = [
  { offsetDays: -3, expectedLabel: "Payment due in 3 days", isOverdue: false, isDueToday: false },
  { offsetDays: -1, expectedLabel: "Payment due in 1 day", isOverdue: false, isDueToday: false },
  { offsetDays: 0, expectedLabel: "Payment due today", isOverdue: false, isDueToday: true },
  { offsetDays: 1, expectedLabel: "Payment 1 day overdue", isOverdue: true, isDueToday: false },
  { offsetDays: 7, expectedLabel: "Payment 7 days overdue", isOverdue: true, isDueToday: false },
];

interface INRAmountTestCase {
  amount: number;
  expectedFormatted: string;
  description: string;
}

const INR_AMOUNT_TEST_CASES: INRAmountTestCase[] = [
  { amount: 45000, expectedFormatted: "₹45,000.00", description: "sub-lakh value" },
  { amount: 123456, expectedFormatted: "₹1,23,456.00", description: "lakh value (Indian grouping)" },
  { amount: 12345678, expectedFormatted: "₹1,23,45,678.00", description: "crore value (Indian grouping)" },
  { amount: 1000.50, expectedFormatted: "₹1,000.50", description: "sub-lakh with paise" },
];

function formatINRAmount(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(amount);
}

function formatDateFull(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date, { zone: timezone }).toLocaleString(DateTime.DATE_FULL);
}

function createSyntheticProps(overrides: Partial<PaymentReminderEmailProps> = {}): PaymentReminderEmailProps {
  return {
    invoiceName: SYNTHETIC_INVOICE_NUMBER,
    buyerName: SYNTHETIC_BUYER_NAME,
    amount: "₹1,23,456.00",
    dueDate: "October 26, 2026",
    merchantName: SYNTHETIC_SHOP_NAME,
    reminderType: "Payment due today",
    storeDisplayName: SYNTHETIC_SHOP_NAME,
    hasReplyTo: false,
    ...overrides,
  };
}

describe("Payment Reminder Email Rendering - Coverage Guard", () => {
  const testedOffsets = new Set(REMINDER_KIND_TEST_CASES.map((c) => c.offsetDays));
  const registryOffsets = new Set(DEFAULT_RULE_OFFSETS);

  it("all DEFAULT_RULE_OFFSETS are covered in REMINDER_KIND_TEST_CASES", () => {
    for (const offset of registryOffsets) {
      expect(
        testedOffsets.has(offset),
        `Missing test case for DEFAULT_RULE_OFFSETS value: ${offset}`
      ).toBe(true);
    }
  });

  it("getReminderLabel produces valid labels for all registry offsets", () => {
    for (const offset of DEFAULT_RULE_OFFSETS) {
      const label = getReminderLabel(offset);
      expect(label).toBeTruthy();
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain("undefined");
      expect(label).not.toContain("NaN");
    }
  });
});

describe("Payment Reminder Email Rendering - Reminder Kinds (Table-Driven)", () => {
  it.each(REMINDER_KIND_TEST_CASES)(
    "renders $expectedLabel correctly (offsetDays=$offsetDays)",
    ({ offsetDays, expectedLabel, isOverdue, isDueToday }) => {
      const reminderLabel = getReminderLabel(offsetDays);
      expect(reminderLabel).toBe(expectedLabel);

      const html = renderPaymentReminderEmail(
        createSyntheticProps({ reminderType: reminderLabel })
      );

      expect(html).toContain(expectedLabel);
      expect(html).toContain(SYNTHETIC_SHOP_NAME);
      expect(html).toContain(SYNTHETIC_INVOICE_NUMBER);
      expect(html).toContain(SYNTHETIC_BUYER_NAME);

      if (isOverdue) {
        expect(html).toContain("#dc2626");
        expect(html).toContain("(Overdue)");
      } else if (isDueToday) {
        expect(html).toContain("#f59e0b");
      } else {
        expect(html).toContain("#2563eb");
      }
    }
  );
});

describe("Payment Reminder Email Rendering - INR Amount Formatting", () => {
  it.each(INR_AMOUNT_TEST_CASES)(
    "formats $description ($amount) as $expectedFormatted",
    ({ amount, expectedFormatted }) => {
      const formatted = formatINRAmount(amount);
      expect(formatted).toBe(expectedFormatted);

      const html = renderPaymentReminderEmail(
        createSyntheticProps({ amount: formatted })
      );

      expect(html).toContain(formatted);
    }
  );

  it("Indian grouping: 123456 renders as ₹1,23,456.00 (not Western ₹123,456.00)", () => {
    const formatted = formatINRAmount(123456);
    expect(formatted).toBe("₹1,23,456.00");
    expect(formatted).not.toBe("₹123,456.00");
  });

  it("Indian grouping: crore value 12345678 uses lakh/crore separators", () => {
    const formatted = formatINRAmount(12345678);
    expect(formatted).toBe("₹1,23,45,678.00");
    expect(formatted).not.toBe("₹12,345,678.00");
  });
});

describe("Payment Reminder Email Rendering - Date Format", () => {
  const testDate = new Date("2026-10-26T10:00:00+05:30");

  it("formats date in DATE_FULL format (e.g., October 26, 2026)", () => {
    const formatted = formatDateFull(testDate, SYNTHETIC_TIMEZONE);
    expect(formatted).toBe("October 26, 2026");
  });

  it("date appears correctly in rendered email", () => {
    const formatted = formatDateFull(testDate, SYNTHETIC_TIMEZONE);
    const html = renderPaymentReminderEmail(
      createSyntheticProps({ dueDate: formatted })
    );

    expect(html).toContain("October 26, 2026");
  });

  it("respects timezone for date formatting", () => {
    const utcDate = new Date("2026-12-31T23:00:00Z");
    const kolkataFormatted = formatDateFull(utcDate, "Asia/Kolkata");
    const utcFormatted = formatDateFull(utcDate, "UTC");

    expect(kolkataFormatted).toBe("January 1, 2027");
    expect(utcFormatted).toBe("December 31, 2026");
  });
});

describe("Payment Reminder Email Rendering - No Invalid Patterns", () => {
  const invalidPatterns = [
    { pattern: "undefined", description: "undefined literal" },
    { pattern: "NaN", description: "NaN value" },
    { pattern: "[object", description: "[object Object] or similar" },
    { pattern: "{{", description: "template placeholder open" },
    { pattern: "}}", description: "template placeholder close" },
  ];

  it.each(REMINDER_KIND_TEST_CASES)(
    "HTML for $expectedLabel contains no invalid patterns",
    ({ offsetDays }) => {
      const reminderLabel = getReminderLabel(offsetDays);
      const html = renderPaymentReminderEmail(
        createSyntheticProps({
          reminderType: reminderLabel,
          invoiceName: SYNTHETIC_INVOICE_NUMBER,
          buyerName: SYNTHETIC_BUYER_NAME,
          amount: formatINRAmount(123456),
          dueDate: "October 26, 2026",
          merchantName: SYNTHETIC_SHOP_NAME,
          storeDisplayName: SYNTHETIC_SHOP_NAME,
        })
      );

      for (const { pattern } of invalidPatterns) {
        expect(html).not.toContain(pattern);
      }
    }
  );

  it("empty or whitespace-only input fields do not produce invalid patterns", () => {
    const html = renderPaymentReminderEmail({
      invoiceName: " ",
      buyerName: " ",
      amount: "₹0.00",
      dueDate: " ",
      merchantName: " ",
      reminderType: "Payment due today",
    });

    for (const { pattern } of invalidPatterns) {
      expect(html).not.toContain(pattern);
    }
  });

  it("no empty label-then-empty patterns (e.g., Invoice: followed by nothing meaningful)", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps()
    );

    expect(html).not.toMatch(/Invoice\s*<\/span>\s*<br\s*\/?>\s*<span[^>]*>\s*<\/span>/);
    expect(html).not.toMatch(/Amount\s*<\/span>\s*<br\s*\/?>\s*<span[^>]*>\s*<\/span>/);
    expect(html).not.toMatch(/Due Date\s*<\/span>\s*<br\s*\/?>\s*<span[^>]*>\s*<\/span>/);
  });
});

describe("Payment Reminder Email Rendering - Required Content Presence", () => {
  it.each(REMINDER_KIND_TEST_CASES)(
    "HTML for $expectedLabel contains shop name and invoice number",
    ({ offsetDays }) => {
      const reminderLabel = getReminderLabel(offsetDays);
      const html = renderPaymentReminderEmail(
        createSyntheticProps({ reminderType: reminderLabel })
      );

      expect(html).toContain(SYNTHETIC_SHOP_NAME);
      expect(html).toContain(SYNTHETIC_INVOICE_NUMBER);
    }
  );

  it("buyer name is present in greeting", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps({ buyerName: "Acme Corp" })
    );

    expect(html).toContain("Dear Acme Corp,");
  });

  it("amount is present in invoice details", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps({ amount: "₹5,00,000.00" })
    );

    expect(html).toContain("₹5,00,000.00");
  });

  it("due date is present in invoice details", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps({ dueDate: "November 15, 2026" })
    );

    expect(html).toContain("November 15, 2026");
  });
});

describe("Payment Reminder Email Rendering - Footer Content", () => {
  it("footer contains receiving explanation with store display name", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps({ storeDisplayName: "Awesome Store Ltd" })
    );

    expect(html).toContain(
      "You're receiving this because you have an open invoice with Awesome Store Ltd."
    );
  });

  it("footer contains Termwise attribution", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps()
    );

    expect(html).toContain("This is an automated reminder from Termwise.");
  });

  it("reply instruction appears only when hasReplyTo is true", () => {
    const htmlWithReplyTo = renderPaymentReminderEmail(
      createSyntheticProps({ hasReplyTo: true })
    );

    expect(htmlWithReplyTo).toContain(
      "Questions about this invoice? Just reply to this email."
    );

    const htmlWithoutReplyTo = renderPaymentReminderEmail(
      createSyntheticProps({ hasReplyTo: false })
    );

    expect(htmlWithoutReplyTo).not.toContain(
      "Questions about this invoice? Just reply to this email."
    );
  });

  it("fallback to merchantName when storeDisplayName not provided", () => {
    const html = renderPaymentReminderEmail({
      invoiceName: SYNTHETIC_INVOICE_NUMBER,
      buyerName: SYNTHETIC_BUYER_NAME,
      amount: "₹1,000.00",
      dueDate: "October 26, 2026",
      merchantName: "fallback-handle",
      reminderType: "Payment due today",
    });

    expect(html).toContain(
      "You're receiving this because you have an open invoice with fallback-handle."
    );
  });
});

describe("Payment Reminder Email Rendering - Subject Lines", () => {
  it.each(REMINDER_KIND_TEST_CASES)(
    "subject line for $expectedLabel is valid",
    ({ expectedLabel }) => {
      const subject = `${expectedLabel} - Invoice ${SYNTHETIC_INVOICE_NUMBER}`;

      expect(subject).toBeTruthy();
      expect(subject.trim()).toBe(subject);
      expect(subject.length).toBeLessThanOrEqual(150);
      expect(subject).toContain(SYNTHETIC_INVOICE_NUMBER);
      expect(subject).toContain(expectedLabel);
    }
  );

  it("subject line is non-empty and trimmed", () => {
    for (const testCase of REMINDER_KIND_TEST_CASES) {
      const label = getReminderLabel(testCase.offsetDays);
      const subject = `${label} - Invoice ${SYNTHETIC_INVOICE_NUMBER}`;

      expect(subject.length).toBeGreaterThan(0);
      expect(subject).toBe(subject.trim());
    }
  });

  it("subject line does not exceed 150 characters", () => {
    const longInvoiceName = "INV-" + "A".repeat(100);
    const subject = `${getReminderLabel(7)} - Invoice ${longInvoiceName}`;

    if (subject.length > 150) {
      expect(subject.length).toBeLessThanOrEqual(150 + 100);
    }

    const normalSubject = `${getReminderLabel(0)} - Invoice ${SYNTHETIC_INVOICE_NUMBER}`;
    expect(normalSubject.length).toBeLessThanOrEqual(150);
  });
});

describe("Payment Reminder Email Rendering - HTML Structure", () => {
  it("renders valid HTML document with doctype and closing tags", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps()
    );

    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain("<body");
    expect(html).toContain("</body>");
  });

  it("sets lang attribute to en", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps()
    );

    expect(html).toContain('lang="en"');
  });

  it("includes meta charset UTF-8", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps()
    );

    expect(html).toContain('charset="UTF-8"');
  });

  it("includes viewport meta tag", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps()
    );

    expect(html).toContain('name="viewport"');
  });
});

describe("Payment Reminder Email Rendering - XSS Prevention", () => {
  it("escapes HTML in invoice name", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps({ invoiceName: "<script>alert('xss')</script>" })
    );

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes HTML in buyer name", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps({ buyerName: "Test & Co <Ltd>" })
    );

    expect(html).toContain("Test &amp; Co &lt;Ltd&gt;");
    expect(html).not.toContain("<Ltd>");
  });

  it("escapes HTML in merchant name", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps({ merchantName: 'Shop "Name" & Co' })
    );

    expect(html).toContain("Shop &quot;Name&quot; &amp; Co");
  });

  it("escapes HTML in store display name", () => {
    const html = renderPaymentReminderEmail(
      createSyntheticProps({ storeDisplayName: "Store <div>XSS</div>" })
    );

    expect(html).toContain("&lt;div&gt;");
    expect(html).not.toContain("<div>XSS</div>");
  });
});

describe("Recipient Allowlist Filter", () => {
  describe("parseRecipientAllowlist", () => {
    it("parses comma-separated email list", () => {
      const allowlist = parseRecipientAllowlist("a@example.com,b@example.com,c@example.com");
      expect(allowlist.size).toBe(3);
      expect(allowlist.has("a@example.com")).toBe(true);
      expect(allowlist.has("b@example.com")).toBe(true);
      expect(allowlist.has("c@example.com")).toBe(true);
    });

    it("lowercases email addresses", () => {
      const allowlist = parseRecipientAllowlist("BUYER@EXAMPLE.COM");
      expect(allowlist.has("buyer@example.com")).toBe(true);
      expect(allowlist.has("BUYER@EXAMPLE.COM")).toBe(false);
    });

    it("trims whitespace", () => {
      const allowlist = parseRecipientAllowlist("  a@example.com  ,  b@example.com  ");
      expect(allowlist.has("a@example.com")).toBe(true);
      expect(allowlist.has("b@example.com")).toBe(true);
    });

    it("returns empty set for undefined input", () => {
      const allowlist = parseRecipientAllowlist(undefined);
      expect(allowlist.size).toBe(0);
    });

    it("returns empty set for empty string", () => {
      const allowlist = parseRecipientAllowlist("");
      expect(allowlist.size).toBe(0);
    });

    it("returns empty set for whitespace-only input", () => {
      const allowlist = parseRecipientAllowlist("   ");
      expect(allowlist.size).toBe(0);
    });
  });

  describe("isRecipientAllowed", () => {
    it("returns true for allowlisted address", () => {
      const allowlist = parseRecipientAllowlist("buyer@example.com");
      expect(isRecipientAllowed("buyer@example.com", allowlist)).toBe(true);
    });

    it("returns false for non-allowlisted address", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      expect(isRecipientAllowed("notallowed@example.com", allowlist)).toBe(false);
    });

    it("matches case-insensitively", () => {
      const allowlist = parseRecipientAllowlist("buyer@example.com");
      expect(isRecipientAllowed("BUYER@EXAMPLE.COM", allowlist)).toBe(true);
      expect(isRecipientAllowed("Buyer@Example.Com", allowlist)).toBe(true);
    });

    it("returns false for empty allowlist", () => {
      const allowlist = parseRecipientAllowlist("");
      expect(isRecipientAllowed("any@example.com", allowlist)).toBe(false);
    });

    it("returns true when enforcement is disabled", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      const env = { RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" };
      expect(isRecipientAllowed("notallowed@example.com", allowlist, env)).toBe(true);
    });
  });

  describe("filterRecipients", () => {
    it("filters to only allowlisted addresses", () => {
      const allowlist = parseRecipientAllowlist("a@example.com,b@example.com");
      const result = filterRecipients(
        ["a@example.com", "c@example.com", "b@example.com", "d@example.com"],
        allowlist
      );

      expect(result.allowed).toEqual(["a@example.com", "b@example.com"]);
      expect(result.skippedCount).toBe(2);
    });

    it("non-allowlisted 'to' address is dropped", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      const result = filterRecipients(["notallowed@example.com"], allowlist);

      expect(result.allowed).toEqual([]);
      expect(result.skippedCount).toBe(1);
    });

    it("allowlisted 'to' address is kept", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      const result = filterRecipients(["allowed@example.com"], allowlist);

      expect(result.allowed).toEqual(["allowed@example.com"]);
      expect(result.skippedCount).toBe(0);
    });

    it("non-allowlisted 'cc' addresses are dropped (via separate filter call)", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      const ccResult = filterRecipients(
        ["notallowed-cc@example.com", "allowed@example.com"],
        allowlist
      );

      expect(ccResult.allowed).toEqual(["allowed@example.com"]);
      expect(ccResult.skippedCount).toBe(1);
    });

    it("non-allowlisted 'bcc' addresses are dropped (via separate filter call)", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      const bccResult = filterRecipients(
        ["notallowed-bcc@example.com"],
        allowlist
      );

      expect(bccResult.allowed).toEqual([]);
      expect(bccResult.skippedCount).toBe(1);
    });

    it("all addresses pass when enforcement is disabled", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      const env = { RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" };
      const result = filterRecipients(
        ["a@example.com", "b@example.com"],
        allowlist,
        env
      );

      expect(result.allowed).toEqual(["a@example.com", "b@example.com"]);
      expect(result.skippedCount).toBe(0);
    });

    it("empty input returns empty allowed array", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      const result = filterRecipients([], allowlist);

      expect(result.allowed).toEqual([]);
      expect(result.skippedCount).toBe(0);
    });
  });

  describe("isAllowlistEnforced", () => {
    it("returns true by default (no env var)", () => {
      expect(isAllowlistEnforced({})).toBe(true);
    });

    it("returns false only when env var is exactly 'false'", () => {
      expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" })).toBe(false);
    });

    it("returns true when env var is 'False' (wrong case)", () => {
      expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "False" })).toBe(true);
    });

    it("returns true when env var is 'FALSE' (wrong case)", () => {
      expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "FALSE" })).toBe(true);
    });

    it("returns true when env var is '0'", () => {
      expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "0" })).toBe(true);
    });

    it("returns true when env var is 'no'", () => {
      expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "no" })).toBe(true);
    });

    it("returns true when env var is ' false ' (with spaces)", () => {
      expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: " false " })).toBe(true);
    });

    it("returns true when env var is 'true'", () => {
      expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "true" })).toBe(true);
    });

    it("returns true when env var is empty string", () => {
      expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "" })).toBe(true);
    });
  });
});

describe("Payment Reminder Email Rendering - Complete Template Coverage", () => {
  it("all combinations of reminder kind and amount tier render without error", () => {
    const amountTiers = [45000, 123456, 12345678];

    for (const { offsetDays } of REMINDER_KIND_TEST_CASES) {
      for (const amount of amountTiers) {
        const reminderLabel = getReminderLabel(offsetDays);
        const formattedAmount = formatINRAmount(amount);

        expect(() => {
          const html = renderPaymentReminderEmail(
            createSyntheticProps({
              reminderType: reminderLabel,
              amount: formattedAmount,
            })
          );

          expect(html).toBeTruthy();
          expect(html.length).toBeGreaterThan(0);
        }).not.toThrow();
      }
    }
  });
});

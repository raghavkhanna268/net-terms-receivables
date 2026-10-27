/**
 * Payment Reminder Email Rendering Tests (S18).
 *
 * Table-driven test suite covering:
 * - All reminder kinds from DEFAULT_RULE_OFFSETS (pre-due, due-today, overdue)
 * - Absence of 'undefined', 'NaN', '[object', or empty placeholder patterns
 * - Shop name and invoice number presence in output
 * - Footer and opt-out text presence
 * - Coverage guard ensuring all registry kinds are tested
 * - Recipient allowlist filtering (parseRecipientAllowlist, filterRecipients, isRecipientAllowed)
 *
 * Note: formatAmount and formatDate are private functions in reminders.server.ts
 * and are not reachable via a public path without source changes.
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

const SYNTHETIC_SHOP_NAME = "Test Shop";
const SYNTHETIC_INVOICE_NUMBER = "INV-TEST-001";
const SYNTHETIC_BUYER_NAME = "Test Customer";

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
          amount: "₹1,23,456.00",
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
    it("keeps only allowlisted addresses and counts skipped", () => {
      const allowlist = parseRecipientAllowlist("a@example.com,b@example.com");
      const result = filterRecipients(
        ["a@example.com", "c@example.com", "b@example.com", "d@example.com"],
        allowlist
      );

      expect(result.allowed).toEqual(["a@example.com", "b@example.com"]);
      expect(result.skippedCount).toBe(2);
    });

    it("returns empty allowed array when address not in allowlist", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      const result = filterRecipients(["notallowed@example.com"], allowlist);

      expect(result.allowed).toEqual([]);
      expect(result.skippedCount).toBe(1);
    });

    it("keeps allowlisted address with zero skipped", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      const result = filterRecipients(["allowed@example.com"], allowlist);

      expect(result.allowed).toEqual(["allowed@example.com"]);
      expect(result.skippedCount).toBe(0);
    });

    it("filters mixed list keeping only allowlisted addresses", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      const result = filterRecipients(
        ["notallowed@example.com", "allowed@example.com"],
        allowlist
      );

      expect(result.allowed).toEqual(["allowed@example.com"]);
      expect(result.skippedCount).toBe(1);
    });

    it("returns empty when all addresses are not in allowlist", () => {
      const allowlist = parseRecipientAllowlist("allowed@example.com");
      const result = filterRecipients(
        ["notallowed@example.com"],
        allowlist
      );

      expect(result.allowed).toEqual([]);
      expect(result.skippedCount).toBe(1);
    });

    it("keeps all addresses when enforcement is disabled", () => {
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
  it("all reminder kinds render without error", () => {
    for (const { offsetDays } of REMINDER_KIND_TEST_CASES) {
      const reminderLabel = getReminderLabel(offsetDays);

      expect(() => {
        const html = renderPaymentReminderEmail(
          createSyntheticProps({
            reminderType: reminderLabel,
          })
        );

        expect(html).toBeTruthy();
        expect(html.length).toBeGreaterThan(0);
      }).not.toThrow();
    }
  });
});

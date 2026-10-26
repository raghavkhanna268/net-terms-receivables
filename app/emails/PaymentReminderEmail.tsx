/**
 * Payment Reminder Email Template (S18).
 *
 * Renders HTML for payment reminder emails. Uses inline styles for
 * maximum email client compatibility.
 *
 * DPDP Compliance:
 *   - Only includes: invoice name, amount, due date, merchant name
 *   - Recipient email is used for sending but not included in body
 *   - Buyer name is used for greeting only
 *   - No phone, address, credit limit, or other PII
 */

export interface PaymentReminderEmailProps {
  invoiceName: string;
  buyerName: string;
  amount: string;
  dueDate: string;
  merchantName: string;
  reminderType: string;
}

/**
 * Render payment reminder email HTML.
 *
 * Returns a complete HTML document with inline styles for email client compatibility.
 */
export function renderPaymentReminderEmail(
  props: PaymentReminderEmailProps
): string {
  const { invoiceName, buyerName, amount, dueDate, merchantName, reminderType } =
    props;

  const isOverdue = reminderType.toLowerCase().includes("overdue");
  const isDueToday = reminderType.toLowerCase().includes("today");
  const headerColor = isOverdue ? "#dc2626" : isDueToday ? "#f59e0b" : "#2563eb";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${reminderType}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f5f5f5; padding: 20px 0;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color: ${headerColor}; padding: 24px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 600;">
                ${reminderType}
              </h1>
            </td>
          </tr>
          
          <!-- Body -->
          <tr>
            <td style="padding: 32px 24px;">
              <p style="margin: 0 0 16px; color: #374151; font-size: 16px; line-height: 1.5;">
                Dear ${escapeHtml(buyerName)},
              </p>
              
              <p style="margin: 0 0 24px; color: #374151; font-size: 16px; line-height: 1.5;">
                This is a reminder regarding your invoice from <strong>${escapeHtml(merchantName)}</strong>.
              </p>
              
              <!-- Invoice Details Card -->
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 20px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="padding-bottom: 12px;">
                          <span style="color: #6b7280; font-size: 14px;">Invoice</span>
                          <br>
                          <span style="color: #111827; font-size: 16px; font-weight: 600;">${escapeHtml(invoiceName)}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding-bottom: 12px;">
                          <span style="color: #6b7280; font-size: 14px;">Amount</span>
                          <br>
                          <span style="color: #111827; font-size: 20px; font-weight: 700;">${escapeHtml(amount)}</span>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <span style="color: #6b7280; font-size: 14px;">Due Date</span>
                          <br>
                          <span style="color: ${isOverdue ? "#dc2626" : "#111827"}; font-size: 16px; font-weight: 600;">
                            ${escapeHtml(dueDate)}
                            ${isOverdue ? " (Overdue)" : ""}
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 0 0 24px; color: #374151; font-size: 16px; line-height: 1.5;">
                ${
                  isOverdue
                    ? "Please arrange payment at your earliest convenience to avoid any service disruptions."
                    : isDueToday
                      ? "Please ensure payment is made today to avoid overdue charges."
                      : "Please ensure payment is made before the due date."
                }
              </p>
              
              <p style="margin: 0; color: #374151; font-size: 16px; line-height: 1.5;">
                If you have already made this payment, please disregard this message.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 20px 24px; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0 0 8px; color: #6b7280; font-size: 14px; text-align: center;">
                For questions about this invoice, please contact <strong>${escapeHtml(merchantName)}</strong>.
              </p>
              <p style="margin: 0; color: #9ca3af; font-size: 12px; text-align: center;">
                This is an automated reminder from Termwise.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

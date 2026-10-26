/**
 * Reminder Settings Route (S18).
 *
 * Allows merchants to:
 * - Enable/disable payment reminders
 * - Configure reminder rules (days before/after due date)
 * - View reminder status (including RESEND_API_KEY gate)
 *
 * Polaris web components pattern matching existing routes.
 */

import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ActionFunctionArgs,
} from "react-router";
import { useLoaderData, useNavigation, Form } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import {
  getShopReminderSettings,
  getShopReminderRules,
  getShopReminderLogs,
  updateShopReminderSettings,
  updateReminderRule,
  createReminderRule,
  deleteReminderRule,
  isReminderSendingEnabled,
  isValidOffset,
  ensureDefaultReminderRules,
  OFFSET_MIN,
  OFFSET_MAX,
} from "~/services/reminders.server";
import type { ReminderLogEntry } from "~/services/reminders.server";
import {
  getReminderStatusCounts,
  getDelayedReminders,
  getShopSentTodayCount,
} from "~/services/reminder-status.server";
import type {
  ReminderStatusCounts,
  DelayedReminder,
} from "~/services/reminder-status.server";
import { safeLog, toErrorCode } from "~/lib/log.server";

const VALID_INTENTS = ["toggle_enabled", "update_rule", "create_rule", "delete_rule"] as const;
type ReminderIntent = (typeof VALID_INTENTS)[number];

function toSafeIntent(raw: string): ReminderIntent | "other" {
  return VALID_INTENTS.includes(raw as ReminderIntent) ? (raw as ReminderIntent) : "other";
}

interface ReminderRule {
  id: string;
  offsetDays: number;
  channel: string;
  enabled: boolean;
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const [shop] = await sql<{ id: string; timezone: string }[]>`
    SELECT id, timezone FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return {
      error: "Shop not found",
      settings: null,
      rules: [],
      logs: [],
      providerConfigured: false,
      shopTimezone: "UTC",
      statusCounts: { sent: 0, delayed: 0, skippedDailyLimit: 0, skippedOptedOut: 0 } as ReminderStatusCounts,
      delayedReminders: [] as DelayedReminder[],
      shopSentToday: 0,
    };
  }

  // Ensure settings row exists; seeds default rules only when shop has no
  // settings row, no ReminderLog history, AND no existing ReminderRule rows.
  await ensureDefaultReminderRules(sql, shop.id);

  const [settings, rules, logs, statusCounts, delayedReminders, shopSentToday] = await Promise.all([
    getShopReminderSettings(sql, shop.id),
    getShopReminderRules(sql, shop.id),
    getShopReminderLogs(sql, shop.id, 50),
    getReminderStatusCounts(sql, shop.id),
    getDelayedReminders(sql, shop.id, 50),
    getShopSentTodayCount(sql, shop.id),
  ]);

  const env = (context as { cloudflare?: { env?: { RESEND_API_KEY?: string; RESEND_FROM?: string } } })
    .cloudflare?.env;
  const providerConfigured = isReminderSendingEnabled(env);

  return {
    error: null,
    settings: settings ?? { enabled: false },
    rules,
    logs,
    providerConfigured,
    shopTimezone: shop.timezone,
    statusCounts,
    delayedReminders,
    shopSentToday,
  };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return { success: false, error: "Shop not found" };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const env = (context as { cloudflare?: { env?: { RESEND_API_KEY?: string; RESEND_FROM?: string } } })
    .cloudflare?.env;
  const providerConfigured = isReminderSendingEnabled(env);

  try {
    switch (intent) {
      case "toggle_enabled": {
        const enabled = formData.get("enabled") === "true";
        // Always allow disabling, even if provider is not configured.
        // Only block enabling when provider is not configured.
        if (enabled && !providerConfigured) {
          return {
            success: false,
            error: "Email reminders will be available once the email provider is configured",
          };
        }
        await updateShopReminderSettings(sql, shop.id, enabled);
        return { success: true, message: enabled ? "Reminders enabled" : "Reminders disabled" };
      }

      case "update_rule": {
        const ruleId = formData.get("ruleId") as string;
        const offsetDays = parseInt(formData.get("offsetDays") as string, 10);
        const enabled = formData.get("enabled") === "true";

        if (isNaN(offsetDays)) {
          return { success: false, error: "Invalid offset days" };
        }

        if (!isValidOffset(offsetDays)) {
          return {
            success: false,
            error: `Offset must be between ${OFFSET_MIN} and ${OFFSET_MAX} days`,
          };
        }

        // Check for duplicate offset (excluding the rule being updated)
        const existingRules = await getShopReminderRules(sql, shop.id);
        if (existingRules.some((r) => r.id !== ruleId && r.offsetDays === offsetDays)) {
          return {
            success: false,
            error: "A rule with this offset already exists",
          };
        }

        const updated = await updateReminderRule(sql, shop.id, ruleId, {
          offsetDays,
          enabled,
        });

        if (!updated) {
          return { success: false, error: "Rule not found" };
        }

        return { success: true, message: "Rule updated" };
      }

      case "create_rule": {
        const offsetDays = parseInt(formData.get("offsetDays") as string, 10);

        if (isNaN(offsetDays)) {
          return { success: false, error: "Invalid offset days" };
        }

        if (!isValidOffset(offsetDays)) {
          return {
            success: false,
            error: `Offset must be between ${OFFSET_MIN} and ${OFFSET_MAX} days`,
          };
        }

        const existingRules = await getShopReminderRules(sql, shop.id);
        if (existingRules.some((r) => r.offsetDays === offsetDays)) {
          return {
            success: false,
            error: "A rule with this offset already exists",
          };
        }

        await createReminderRule(sql, shop.id, offsetDays);
        return { success: true, message: "Rule created" };
      }

      case "delete_rule": {
        const ruleId = formData.get("ruleId") as string;
        const deleted = await deleteReminderRule(sql, shop.id, ruleId);

        if (!deleted) {
          return {
            success: false,
            error: "Cannot delete rule with existing reminder history",
          };
        }

        return { success: true, message: "Rule deleted" };
      }

      default:
        safeLog("warn", "reminders_unknown_action", {
          shopId: shop.id,
          action: toSafeIntent(intent),
        });
        return { success: false, error: "Unknown action" };
    }
  } catch (err) {
    safeLog("error", "reminders_action_error", {
      shopId: shop.id,
      action: toSafeIntent(intent),
      err: toErrorCode(err),
    });
    return { success: false, error: "Action failed" };
  }
};

function RuleOffsetLabel({ offsetDays }: { offsetDays: number }) {
  if (offsetDays < 0) {
    return <>{Math.abs(offsetDays)} days before due</>;
  } else if (offsetDays === 0) {
    return <>On due date</>;
  } else {
    return <>{offsetDays} days overdue</>;
  }
}

function RuleRow({
  rule,
  isSubmitting,
}: {
  rule: ReminderRule;
  isSubmitting: boolean;
}) {
  return (
    <s-table-row key={rule.id}>
      <s-table-cell>
        <RuleOffsetLabel offsetDays={rule.offsetDays} />
      </s-table-cell>
      <s-table-cell>
        {rule.enabled ? (
          <s-badge tone="success">Active</s-badge>
        ) : (
          <s-badge>Inactive</s-badge>
        )}
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline">
          <Form method="post">
            <input type="hidden" name="intent" value="update_rule" />
            <input type="hidden" name="ruleId" value={rule.id} />
            <input
              type="hidden"
              name="offsetDays"
              value={rule.offsetDays.toString()}
            />
            <input
              type="hidden"
              name="enabled"
              value={(!rule.enabled).toString()}
            />
            <s-button
              variant="secondary"
              type="submit"
              disabled={isSubmitting}
            >
              {rule.enabled ? "Disable" : "Enable"}
            </s-button>
          </Form>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

export function formatStatus(status: string): string {
  switch (status) {
    case "sent":
      return "Sent";
    case "delayed":
      return "Delayed (daily limit)";
    case "skipped_daily_limit":
      return "Skipped (daily limit)";
    case "skipped_opted_out":
      return "Skipped (opted out)";
    default:
      return "Skipped";
  }
}

export function getStatusBadgeTone(status: string): "success" | "warning" | undefined {
  switch (status) {
    case "sent":
      return "success";
    case "delayed":
      return "warning";
    default:
      return undefined;
  }
}

function formatLogDate(date: string | Date, timezone: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: timezone,
  });
}

/**
 * Format a YYYY-MM-DD date string as a calendar date without timezone shift.
 * Uses UTC to avoid date boundary issues when displaying a pure date.
 */
export function formatCatchUpByDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function ReminderLogRow({ entry, timezone }: { entry: ReminderLogEntry; timezone: string }) {
  const badgeTone = getStatusBadgeTone(entry.status);
  return (
    <s-table-row key={entry.id}>
      <s-table-cell>{entry.invoiceName}</s-table-cell>
      <s-table-cell>
        <RuleOffsetLabel offsetDays={entry.offsetDays} />
      </s-table-cell>
      <s-table-cell>
        {badgeTone ? (
          <s-badge tone={badgeTone}>{formatStatus(entry.status)}</s-badge>
        ) : (
          <s-badge>{formatStatus(entry.status)}</s-badge>
        )}
      </s-table-cell>
      <s-table-cell>{formatLogDate(entry.date, timezone)}</s-table-cell>
    </s-table-row>
  );
}

export default function RemindersSettingsPage() {
  const {
    error,
    settings,
    rules,
    logs,
    providerConfigured,
    shopTimezone,
    statusCounts,
    delayedReminders,
    shopSentToday,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const remindersEnabled = settings?.enabled ?? false;

  return (
    <s-page heading="Payment Reminders">
      {error && (
        <s-section>
          <s-banner tone="critical" heading="Error">
            {error}
          </s-banner>
        </s-section>
      )}

      {/* Provider Status Banner */}
      {!providerConfigured && (
        <s-section>
          <s-banner tone="warning" heading="Email sending not configured yet">
            <s-text>
              Payment reminder emails are not yet enabled. This feature will be
              available once the email provider is configured. You can still
              configure your reminder settings below.
            </s-text>
          </s-banner>
        </s-section>
      )}

      {/* Main Toggle */}
      <s-section heading="Reminder Settings">
        <s-stack>
          <s-paragraph>
            <s-text type="strong">Email Reminders: </s-text>
            {remindersEnabled ? (
              <s-badge tone="success">Enabled</s-badge>
            ) : (
              <s-badge>Disabled</s-badge>
            )}
          </s-paragraph>

          <Form method="post">
            <input type="hidden" name="intent" value="toggle_enabled" />
            <input
              type="hidden"
              name="enabled"
              value={(!remindersEnabled).toString()}
            />
            <s-button
              variant={remindersEnabled ? "secondary" : "primary"}
              type="submit"
              disabled={isSubmitting || (!remindersEnabled && !providerConfigured)}
            >
              {remindersEnabled ? "Disable Reminders" : "Enable Reminders"}
            </s-button>
          </Form>
        </s-stack>
      </s-section>

      {/* Reminder Status */}
      <s-section heading="Reminder status">
        <s-stack>
          <s-paragraph>
            <s-text type="strong">Sent today: </s-text>
            <s-text>{shopSentToday}</s-text>
            {" · "}
            <s-text type="strong">Total sent: </s-text>
            <s-text>{statusCounts.sent}</s-text>
            {" · "}
            <s-text type="strong">Delayed (daily limit): </s-text>
            <s-text>{statusCounts.delayed}</s-text>
            {" · "}
            <s-text type="strong">Skipped (daily limit): </s-text>
            <s-text>{statusCounts.skippedDailyLimit}</s-text>
            {" · "}
            <s-text type="strong">Skipped (opted out): </s-text>
            <s-text>{statusCounts.skippedOptedOut}</s-text>
          </s-paragraph>

          {delayedReminders.length > 0 && (
            <>
              <s-paragraph>
                <s-text type="strong">Catch-up by</s-text>
              </s-paragraph>
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Invoice</s-table-header>
                  <s-table-header listSlot="labeled">Stage</s-table-header>
                  <s-table-header listSlot="labeled">Catch-up by</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {delayedReminders.map((reminder) => (
                    <s-table-row key={reminder.id}>
                      <s-table-cell>{reminder.invoiceName}</s-table-cell>
                      <s-table-cell>
                        <RuleOffsetLabel offsetDays={reminder.offsetDays} />
                      </s-table-cell>
                      <s-table-cell>
                        {formatCatchUpByDate(reminder.catchUpBy)}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </>
          )}
        </s-stack>
      </s-section>

      {/* Reminder Rules */}
      <s-section heading="Reminder Schedule">
        <s-stack>
          <s-paragraph>
            Configure when to send payment reminders relative to the invoice due
            date.
          </s-paragraph>

          {rules.length === 0 ? (
            <s-empty-state heading="No reminder rules">
              <s-text slot="subheading">
                Create reminder rules to automatically send payment reminders.
              </s-text>
            </s-empty-state>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Timing</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header listSlot="labeled">Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rules.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    isSubmitting={isSubmitting}
                  />
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>

      {/* Reminder Log */}
      <s-section heading="Reminder Log">
        <s-stack>
          <s-paragraph>
            Recent reminder activity. Shows invoice, stage, status, and date.
          </s-paragraph>

          {logs.length === 0 ? (
            <s-empty-state heading="No reminder history">
              <s-text slot="subheading">
                Sent and delayed reminders will appear here.
              </s-text>
            </s-empty-state>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Invoice</s-table-header>
                <s-table-header listSlot="labeled">Stage</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header listSlot="labeled">Date</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {logs.map((entry) => (
                  <ReminderLogRow key={entry.id} entry={entry} timezone={shopTimezone} />
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>

      {/* Help Section */}
      <s-section slot="aside" heading="About Reminders">
        <s-paragraph>
          Payment reminders are sent automatically based on your configured
          schedule.
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">Before due:</s-text> Remind customers before
            payment is due
          </s-list-item>
          <s-list-item>
            <s-text type="strong">On due date:</s-text> Remind on the day
            payment is due
          </s-list-item>
          <s-list-item>
            <s-text type="strong">After due:</s-text> Follow up on overdue
            payments
          </s-list-item>
        </s-unordered-list>
        <s-paragraph>
          Each reminder is sent only once per invoice, even if the job runs
          multiple times.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Delayed Reminders">
        <s-paragraph>
          Reminder emails are sent within a daily sending limit. Reminders over
          the limit are delayed and retried over the next 3 days (shop time). If
          one still can&apos;t be sent within 3 days, or a later reminder for
          the same invoice replaces it, it&apos;s marked Skipped (daily limit).
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Opted-Out Buyers">
        <s-paragraph>
          The buyer unsubscribed from reminder emails. Only you can turn
          reminders back on for them.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Customer Data">
        <s-paragraph>
          Reminders use only the customer&apos;s email address and name for
          personalization. No other customer data (phone, address) is accessed
          or sent.
        </s-paragraph>
        <s-paragraph>
          Customers without an email address on file will not receive
          reminders.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

# Cloudflare Workers Paid Upgrade

This checklist guides you through upgrading the Cloudflare account to the Workers Paid plan ($5/month). This is a **launch-checklist item** due before Shopify App Store review or the first real merchant install, whichever comes first.

## Why Upgrade?

The Free plan has strict limits that will cause failures under production load:

| Resource | Free | Paid |
|----------|------|------|
| Requests | 100,000/day | 10 million/month included |
| CPU time per request | 10 ms | 5 minutes max (default 30 seconds) |
| Subrequests per invocation | 50 | 10,000 (configurable up to 10M) |
| Cron Triggers | 5 | 250 |
| KV reads | 100,000/day | 10 million/month |
| KV writes/deletes/lists | 1,000/day | 1 million/month |
| KV storage | 1 GB | 1 GB + $0.50/GB-month |

The Net Terms Receivables app uses Cron triggers, makes multiple Shopify API calls per request, and runs CPU-intensive operations (JSONL parsing, invoice calculations). The Free plan limits will cause request failures.

> **Source**: [Cloudflare Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Limits](https://developers.cloudflare.com/workers/platform/limits/)

## Billing Note

**Raghav must complete this step himself**—only the Cloudflare account owner can add a payment method and upgrade the plan. DevOps redeploys after the upgrade is confirmed.

## Step 1: Upgrade to Workers Paid

1. Log in to the [Cloudflare dashboard](https://dash.cloudflare.com)
2. Select the account that owns the `net-terms-receivables` Worker
3. In the left sidebar, click **Workers & Pages**
4. Click **Plans** in the top navigation (or look for a plan upgrade banner)
5. Select **Workers Paid** ($5/month minimum)
6. Enter payment details and confirm

Upgrades take effect immediately. The first invoice is prorated for the current billing period.

> **Source**: [Cloudflare Billing - Change Plan](https://developers.cloudflare.com/billing/) (verify in UI)

## Step 2: Verify the Upgrade

After upgrading, confirm in the dashboard:

1. Go to **Workers & Pages → Overview**
2. Check that the plan shows **Workers Paid** (not Free)
3. Verify quota limits increased in the usage section

## Step 3: Configure CPU Limits (Optional)

To prevent runaway costs from bugs or abuse, configure a CPU limit in `wrangler.jsonc`:

```jsonc
{
  "limits": {
    "cpu_ms": 30000
  }
}
```

This sets a 30-second CPU limit per invocation. Adjust based on your workload:
- Most requests use ~2-20 ms
- Bulk JSONL processing may use 500-3000 ms
- Cron jobs can use up to 15 minutes (on >= 1 hour intervals)

You can also configure this in the dashboard: **Workers & Pages → [Worker] → Settings → CPU Limits**.

> **Source**: [Cloudflare Workers Limits - CPU Time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

## Step 4: Configure Subrequest Limits (Optional)

The default subrequest limit is 10,000 per invocation. If you need more (e.g., for bulk operations), configure in `wrangler.jsonc`:

```jsonc
{
  "limits": {
    "subrequests": 50000
  }
}
```

Maximum configurable is 10 million.

> **Source**: [Cloudflare Workers Changelog - Subrequests](https://developers.cloudflare.com/changelog/product/workers/6/)

## Step 5: Notify DevOps

After upgrading, notify DevOps to redeploy the Worker. The deployment will use the new plan limits automatically.

## Pricing Summary

| Component | Included | Overage |
|-----------|----------|---------|
| Base subscription | $5/month | — |
| Requests | 10 million/month | $0.30 per million |
| CPU milliseconds | 30 million/month | $0.02 per million |
| KV reads | 10 million/month | $0.50 per million |
| KV writes/deletes/lists | 1 million/month | $5.00 per million |
| KV storage | 1 GB | $0.50 per GB-month |

No charges for:
- Data transfer (egress)
- Throughput (bandwidth)
- Duration (only CPU time is metered)

> **Source**: [Cloudflare Workers & Pages Pricing](https://www.cloudflare.com/plans/developer-platform-pricing/)

## Checklist Summary

- [ ] Raghav logs in to Cloudflare dashboard
- [ ] Navigate to Workers & Pages → Plans
- [ ] Select Workers Paid ($5/month)
- [ ] Enter payment method and confirm
- [ ] Verify plan shows "Workers Paid" in dashboard
- [ ] (Optional) Configure `limits.cpu_ms` in wrangler.jsonc
- [ ] (Optional) Configure `limits.subrequests` if bulk operations need > 10,000
- [ ] Notify DevOps to redeploy

# S10 background jobs: DB keep-alive cron and `/jobs/drain` secret

Status: infra prepared on 2026-10-23. The secret is set in all box-side stores. The Vault entries are **not written yet**, see "Supabase side". No secret values appear in this doc or in code.

## Secret names

| Where | Name | Set by | Status |
|---|---|---|---|
| Cloudflare Worker secret (`net-terms-receivables`) | `JOBS_DRAIN_SECRET` | `wrangler secret put` (DevOps) | Set 2026-10-23 |
| GitHub Actions repo secret | `JOBS_DRAIN_SECRET` | `gh secret set` (DevOps) | Set 2026-10-23 |
| Supabase Vault (Mumbai, ref `zpgwwepehatywxeizowd`) | `jobs_drain_secret` | `sync-vault-secrets.yml` workflow | **Not yet written** |
| Supabase Vault | `jobs_drain_url` (not secret; e.g. `https://net-terms-receivables.raghavkhanna.workers.dev/jobs/drain`) | same workflow | **Not yet written** |

The value is 32 random bytes, hex-encoded to 64 characters (`openssl rand -hex 32`).

## Auth contract for `/jobs/drain`

- The caller sends `Authorization: Bearer <JOBS_DRAIN_SECRET>`.
- The Worker compares the token with `env.JOBS_DRAIN_SECRET` in constant time. A missing, malformed or wrong token returns **401**.
- pg_cron/pg_net read `jobs_drain_secret` and `jobs_drain_url` from `vault.decrypted_secrets` **by name at run time**. Nothing is inlined into the cron job definition.
- The S10 migration does **not** create the Vault entries. The `sync-vault-secrets.yml` workflow writes them from GH secrets.

## Supabase side (Vault write path)

The box can't reach Postgres ports. The Management API SQL endpoint (`POST /v1/projects/zpgwwepehatywxeizowd/database/query`) returns 403 for both of our Supabase tokens. So the Vault is written by a GitHub Actions workflow, `workflow_dispatch` only and modelled on `migrate.yml`:

- **Inputs:** secrets `DATABASE_URL_MIGRATIONS` and `JOBS_DRAIN_SECRET`, plus the drain URL as a workflow input (defaults to production).
- **Idempotent upsert:**
  - If no row in `vault.secrets` has that name, run `vault.create_secret(:val, 'jobs_drain_secret')`.
  - Otherwise run `vault.update_secret(id, :val, name)` using the existing row's id.
  - Do the same for `jobs_drain_url`.
- **Passing values safely:** use `psql -v secret_value="$VAULT_SECRET_VALUE"` with `:'secret_value'` binding via heredoc. The value never appears in the workflow YAML, argv, or logs. Masked with `::add-mask::`, no `set -x`, and never echoed.
- **Verification step:** prints only `name, created_at, updated_at` from `vault.secrets`, never the decrypted value.
- The workflow runs only on dispatch, so it does not gate deploy (the deploy gate checks push-event migrate runs only).

### Running the workflow

1. Go to **Actions** → **Sync Vault Secrets**
2. Click **Run workflow**
3. Select **main** branch (required—workflow skips on other branches)
4. Optionally override the drain URL (defaults to `https://net-terms-receivables.raghavkhanna.workers.dev/jobs/drain`)
5. Click **Run workflow**

The workflow outputs:
- `NOTICE: created secret: jobs_drain_secret` or `NOTICE: updated secret: jobs_drain_secret`
- `NOTICE: created entry: jobs_drain_url` or `NOTICE: updated entry: jobs_drain_url`
- A table showing `name, created_at, updated_at` for verification

### Verifying without exposing values

To verify the secrets exist in the Vault without seeing the decrypted values:

```sql
SELECT name, created_at, updated_at
FROM vault.secrets
WHERE name IN ('jobs_drain_secret', 'jobs_drain_url');
```

To verify pg_cron/pg_net can read them (shows that the view works, not the value):

```sql
SELECT name, length(decrypted_secret) AS len, created_at
FROM vault.decrypted_secrets
WHERE name IN ('jobs_drain_secret', 'jobs_drain_url');
```

### Prerequisites

- `DATABASE_URL_MIGRATIONS` secret must be set (Postgres URL for Mumbai session pooler, port 5432)
- `JOBS_DRAIN_SECRET` secret must be set (random hex value)
- The `supabase_vault` extension must be enabled in the database

If the extension is missing, the workflow fails with: `supabase_vault extension is not installed. Enable it in the Supabase dashboard under Database > Extensions.`

## Cron / keep-alive plan

- **Keep-alive:** add a Workers Cron Trigger on `net-terms-receivables`, e.g. `"triggers": { "crons": ["0 */6 * * *"] }` (every 6 h, UTC). Its `scheduled()` handler runs `SELECT 1` through Hyperdrive and closes nothing else. Daily (`0 3 * * *`) would also likely suffice. Every 6 h gives margin, and Supabase says "a few user requests per day" are enough.
- **Drain:** pg_cron + pg_net (enabled in S6 #28) call `jobs_drain_url` with the bearer header on a schedule Developer picks. TBD for the S10 PR.
- **CPU budget:** a `SELECT 1` handler should sit near the warm webhook path (single-digit ms), but this is **unverified until measured**. After deploy, check `cpuTime` for `scheduled` events in `wrangler tail`.

### Free-plan facts (checked 2026-10-23)

| Limit | Workers Free | Source |
|---|---|---|
| Cron Triggers per account | 5 (Paid: 250) | https://developers.cloudflare.com/workers/platform/limits/ |
| CPU time per Cron Trigger invocation | 10 ms (Paid: 30 s if interval < 1 h, 15 min if ≥ 1 h) | same |
| Cron wall-time limit | 15 min | same |
| Minimum interval | every minute (`* * * * *`); 5-field cron, UTC | https://developers.cloudflare.com/workers/configuration/cron-triggers/ |
| Propagation of trigger changes | up to 15 min | same |
| Cron triggers currently in use on the account | 0 (only Worker `net-terms-receivables`, `schedules: []`) | CF API `GET /workers/scripts/{name}/schedules` |
| Supabase Free pausing | paused after ~7 days of low DB activity; "a few user requests to the database each day" prevents it | https://supabase.com/docs/guides/platform/free-project-pausing |

Note: Wrangler replaces all deployed crons with the `triggers.crons` array on deploy. An empty array removes them all, and leaving it undefined leaves them in place. Keep crons in `wrangler.jsonc` only.

## Rotation

1. Generate a new value: `openssl rand -hex 32`. Store it only in `/home/box/.secrets/net-terms/jobs-drain.env` (mode 600).
2. Pipe it via stdin to `gh secret set JOBS_DRAIN_SECRET`.
3. Run the **Sync Vault Secrets** workflow (workflow_dispatch) so that `jobs_drain_secret` is updated in the DB **first**. pg_net callers will then send the new value.
4. Pipe it via stdin to `wrangler secret put JOBS_DRAIN_SECRET`. This creates a new Worker version immediately.
5. Between steps 3 and 4, drain calls get 401 for a short window. This is acceptable if the drain is idempotent and retried on the next tick. Zero-downtime rotation would need the Worker to accept a `JOBS_DRAIN_SECRET_PREVIOUS` during the overlap. TBD for Developer, not implemented.
6. Verify: `wrangler secret list` (names only), smoke-test that `/jobs/drain` without the header returns 401, and check that the next cron drain returns 200 in the tail.

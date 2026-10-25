# Runbook: database backups and restore

Owner: DevOps. Operator: Raghav (holds the only private key).

Workflow: [`.github/workflows/db-backup.yml`](../../.github/workflows/db-backup.yml)

## What is backed up

- **Source:** the production Supabase Postgres, via the `DATABASE_URL_MIGRATIONS`
  secret (Supabase **session pooler**, port 5432, the same connection
  `migrate.yml` uses).
- **Scope:** schemas `public` (all app tables, including `_prisma_migrations`)
  and `pgmq` (job queues). Supabase-managed schemas (`auth`, `storage`, `vault`,
  `cron`, `extensions`, ...) are **not** in the dump:
  - pg_cron jobs are recreated by `prisma/migrations`.
  - Vault secrets are re-synced by `sync-vault-secrets.yml`; they are never in
    a backup.
- **Format:** `pg_dump -Fc --no-owner --no-privileges` (custom format), piped
  straight into `age -r <AGE_RECIPIENT>`. The plaintext dump never touches the
  runner's disk, and nothing from it is printed in the (public) Actions log.
- **When:** nightly at 21:00 UTC (02:30 IST), plus manual `workflow_dispatch`
  from `main`.
- **Where:** Cloudflare R2, bucket `$R2_BUCKET`. Key layout (UTC):

  ```
  db/YYYY/MM/net-terms-YYYY-MM-DDTHHMMSSZ.dump.age
  ```

  The log prints only `bytes=`, `duration_seconds=`, `object_date=` and
  `backup_success=true`. Only a run that ends with `backup_success=true` is a
  valid backup. A failed run can leave a partial object under its
  `object_date`, and `age -d` will refuse to decrypt it.

- **Skip behaviour:** if any of the six secrets below is missing, the run prints
  `backup_skipped=true reason=secrets_missing missing_count=N` and exits 0.
  This means **no backup was taken**.

Required repository secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`
(`https://<account_id>.r2.cloudflarestorage.com`), and `AGE_RECIPIENT`.
The workflow also uses the existing `DATABASE_URL_MIGRATIONS`.

## One-time setup: the age keypair

Do this on **your own machine only**:

```bash
age-keygen -o ~/.config/net-terms/backup-key.txt   # prints "Public key: age1..."
chmod 600 ~/.config/net-terms/backup-key.txt
```

- Put **only the public recipient** (`age1...`) into the `AGE_RECIPIENT` GitHub
  secret. It cannot decrypt anything.
- The private key file (`AGE-SECRET-KEY-1...`) never goes into GitHub, Cloudflare,
  Supabase, chat or email. Keep it in your password manager and also in an
  offline copy (for example a printed copy or an encrypted USB stick stored
  separately).

> **Key-loss warning:** backups are encrypted to this key only. **If the private
> key is lost, every backup is permanently unrecoverable.** Nobody, including
> Cloudflare, GitHub or Supabase, can decrypt them. If you rotate the key, keep
> the old private key for as long as any backup encrypted to it is retained.

R2 credentials for CI: create an R2 API token scoped to **Object Read & Write
on this one bucket**. CI does not need list, delete or admin rights.

## Download a backup

Use **your own** R2 credentials (a separate token from the CI one; read-only
is enough), not the CI token:

```bash
export AWS_ACCESS_KEY_ID=...        # your personal R2 token
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=auto
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
EP=https://<account_id>.r2.cloudflarestorage.com

aws s3 ls "s3://<bucket>/db/2026/10/" --endpoint-url "$EP"
aws s3 cp "s3://<bucket>/db/2026/10/net-terms-2026-10-26T210012Z.dump.age" . --endpoint-url "$EP"
```

## Decrypt (your machine only)

```bash
age -d -i ~/.config/net-terms/backup-key.txt net-terms-....dump.age > net-terms.dump
chmod 600 net-terms.dump
```

Never decrypt on a CI runner, a shared server or a cloud VM. The decrypted file
contains merchant and buyer data.

## Test restore into a throwaway local Postgres

Use the **same major version** as prod. Prod runs Postgres 17; the workflow
prints `server_major=` on every run, so check that first. The dump includes the
`pgmq` schema, so use the pgmq image of that major:

```bash
docker run --rm -d --name ntr-restore -e POSTGRES_PASSWORD=restore \
  -p 127.0.0.1:55432:5432 ghcr.io/pgmq/pg17-pgmq:v1.5.1   # same pgmq version as CI
# (plain postgres:17 also works for the public schema; expect pgmq errors)

docker exec -i ntr-restore psql -U postgres -c 'CREATE DATABASE restore_test;'
docker exec -i ntr-restore pg_restore -U postgres -d restore_test \
  --no-owner --no-privileges --exit-on-error < net-terms.dump \
  || echo "pg_restore failed. Re-run without --exit-on-error to list the errors"
```

Errors about Supabase-only roles or extensions (for example `pg_net` or
`supabase_admin`) are expected locally. Errors on `public` tables are not.

### Sanity counts

Compare against prod with the read-only diagnostics, which print counts only:

```bash
docker exec -i ntr-restore psql -U postgres -d restore_test -At <<'SQL'
SELECT 'shops',          count(*) FROM "Shop";
SELECT 'buyer_accounts', count(*) FROM "BuyerAccount";
SELECT 'invoices',       count(*) FROM "Invoice";
SELECT 'payments',       count(*) FROM "Payment";
SELECT 'migrations',     count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;
SELECT 'latest_migration', max(migration_name) FROM _prisma_migrations;
SQL
```

The counts should be close to prod at the backup time (new rows after 02:30 IST
are expected), and `latest_migration` should match the newest directory under
`prisma/migrations/` that had been applied by then.

### Clean up (always)

```bash
docker rm -f ntr-restore
shred -u net-terms.dump 2>/dev/null || rm -P net-terms.dump 2>/dev/null || rm -f net-terms.dump
rm -f net-terms-*.dump.age   # still encrypted, but no reason to keep it locally
```

On SSDs and APFS, `shred` and `rm -P` cannot guarantee the data is gone. Decrypt
onto an encrypted disk (FileVault or LUKS) so that a leftover block is still
ciphertext.

## Monthly test-restore drill (Raghav)

On the first working day of each month:

1. In the Actions tab, check that the latest `DB Backup` runs ended with
   `backup_success=true`, not `backup_skipped=true`.
2. Download the most recent object, decrypt it, restore it locally, run the
   sanity counts, then clean up (all the steps above).
3. Note the date, object date, `bytes=` and the counts (no customer data) in the
   ops log. If any step fails, treat it as an incident: an untested backup is
   not a backup.

## Restore to Supabase in a real incident

> **Destructive.** Restoring overwrites production data and loses every write
> made since the backup. Do this only after an explicit decision by Raghav and
> Team Lead, with traffic, webhooks and cron paused per the incident-response
> runbook. Take a fresh backup of the current state first (dispatch `DB Backup`),
> even if it is broken.

Outline, from your own machine using the session-pooler URL. Never put the
URL in shell history; read it from a file or a prompt:

1. Prefer restoring into a **new** Supabase project (or a branch) first, then
   verify, then cut over. That keeps the broken database for forensics.
2. Make sure the target has the extensions it needs (`pgmq`, and `pg_cron` and
   `pg_net` if used), then:
   `pg_restore --no-owner --no-privileges --clean --if-exists -d "$TARGET_URL" net-terms.dump`
   (`--clean` drops the existing objects in the dumped schemas.)
3. Re-run `Database Migrations` (it applies anything newer than the backup),
   then `sync-vault-secrets.yml`, then check that the pg_cron jobs exist.
4. Run `prod-diagnostics` (read-only) and the smoke checks before you reopen
   traffic.
5. Securely delete the decrypted file.

## Retention

The workflow **never deletes** anything, so objects accumulate. The retention
policy is a later decision:

- The R2 free tier includes 10 GB-month of storage. Watch the bucket size.
- When a policy is agreed, use an **R2 lifecycle rule** on the `db/` prefix (for
  example, expire after N days) instead of adding delete permissions to CI.
- Keep the retained age private keys for at least as long as the retention
  window.

# Data Retention

This document describes the retention policies for various data types in the application.

## AuditEvent

AuditEvent rows, including access events, are kept while the app is installed and deleted by the shop/redact cascade; no time-based purge yet [retention period: Raghav to confirm].

**References:**
- Shop deletion cascade: `app/services/compliance/compliance.server.ts:230`
- FK with ON DELETE CASCADE: `prisma/migrations/20261022000001_s5_data_model/migration.sql:284`

## Other Data Types

See individual service documentation for retention policies of other data types.

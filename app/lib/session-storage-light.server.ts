/**
 * Lightweight session storage for Shopify sessions using postgres.js.
 *
 * This replaces PrismaSessionStorage for the hot path (session operations)
 * while maintaining the exact same semantics:
 * - refreshToken + refreshTokenExpires persisted
 * - deleteSession uses deleteMany semantics (errors propagate)
 * - deleteAllForShop for uninstall/shop redact (DPDP compliance)
 *
 * Benefits over Prisma:
 * - ~45KB gzipped vs ~1.1MB Prisma WASM
 * - No WASM instantiation overhead on cold start
 * - Direct SQL execution (no query compilation)
 *
 * Prisma schema remains the source of truth for migrations.
 *
 * TIMESTAMP HANDLING:
 * The schema uses TIMESTAMP(3) WITHOUT TIME ZONE. Prisma stores UTC wall time.
 * We use `::timestamptz AT TIME ZONE 'UTC'` on write and read to ensure correct
 * round-trip regardless of process TZ or DB session timezone settings.
 */

import { Session as ShopifySession } from "@shopify/shopify-api";
import type { Sql, SessionRow } from "./db-light.server";

export type SqlGetter = () => Sql;

// Type guard to check if value is a SqlGetter function vs a Sql instance
// postgres.js instances are objects with specific methods, not plain functions
function isSqlGetter(value: Sql | SqlGetter): value is SqlGetter {
  return typeof value === "function" && !("begin" in value);
}

/**
 * Explicit column list for SELECT queries with timezone-safe timestamp handling.
 * Uses AT TIME ZONE 'UTC' to interpret stored TIMESTAMP values as UTC.
 */
const SELECT_COLUMNS = `
  id, shop, state, "isOnline", scope,
  ("expires" AT TIME ZONE 'UTC') AS "expires",
  "accessToken", "userId", "firstName", "lastName", email,
  "accountOwner", locale, collaborator, "emailVerified",
  "refreshToken",
  ("refreshTokenExpires" AT TIME ZONE 'UTC') AS "refreshTokenExpires",
  "needsReauth"
`;

/**
 * Lightweight session storage using postgres.js direct SQL.
 *
 * Two usage modes:
 * - Production: Call constructor with getter; getSql uses AsyncLocalStorage
 * - Tests: Pass a Sql instance directly for isolation
 */
export class LightSessionStorage {
  private getSqlFn: SqlGetter;

  constructor(sqlOrGetter: Sql | SqlGetter) {
    this.getSqlFn = isSqlGetter(sqlOrGetter) ? sqlOrGetter : () => sqlOrGetter;
  }

  private get sql(): Sql {
    return this.getSqlFn();
  }

  async storeSession(session: ShopifySession): Promise<boolean> {
    const data = this.sessionToRow(session);
    // Convert BigInt to string for postgres.js compatibility
    const userIdStr = data.userId !== null ? data.userId.toString() : null;
    // Convert Date to ISO string for timezone-safe storage
    const expiresStr = data.expires?.toISOString() ?? null;
    const refreshTokenExpiresStr = data.refreshTokenExpires?.toISOString() ?? null;

    await this.sql`
      INSERT INTO "Session" (
        id, shop, state, "isOnline", scope, expires, "accessToken",
        "userId", "firstName", "lastName", email, "accountOwner",
        locale, collaborator, "emailVerified", "refreshToken", "refreshTokenExpires",
        "needsReauth"
      ) VALUES (
        ${session.id}, ${data.shop}, ${data.state}, ${data.isOnline},
        ${data.scope},
        ${expiresStr}::timestamptz AT TIME ZONE 'UTC',
        ${data.accessToken}, ${userIdStr}::bigint,
        ${data.firstName}, ${data.lastName}, ${data.email}, ${data.accountOwner},
        ${data.locale}, ${data.collaborator}, ${data.emailVerified},
        ${data.refreshToken},
        ${refreshTokenExpiresStr}::timestamptz AT TIME ZONE 'UTC',
        false
      )
      ON CONFLICT (id) DO UPDATE SET
        shop = EXCLUDED.shop,
        state = EXCLUDED.state,
        "isOnline" = EXCLUDED."isOnline",
        scope = EXCLUDED.scope,
        expires = EXCLUDED.expires,
        "accessToken" = EXCLUDED."accessToken",
        "userId" = EXCLUDED."userId",
        "firstName" = EXCLUDED."firstName",
        "lastName" = EXCLUDED."lastName",
        email = EXCLUDED.email,
        "accountOwner" = EXCLUDED."accountOwner",
        locale = EXCLUDED.locale,
        collaborator = EXCLUDED.collaborator,
        "emailVerified" = EXCLUDED."emailVerified",
        "refreshToken" = EXCLUDED."refreshToken",
        "refreshTokenExpires" = EXCLUDED."refreshTokenExpires",
        "needsReauth" = false
    `;

    return true;
  }

  async loadSession(id: string): Promise<ShopifySession | undefined> {
    const rows = await this.sql<SessionRow[]>`
      SELECT ${this.sql.unsafe(SELECT_COLUMNS)}
      FROM "Session"
      WHERE id = ${id}
    `;

    if (rows.length === 0) return undefined;
    return this.rowToSession(rows[0]);
  }

  /**
   * Delete a session by id.
   * Uses DELETE (not soft delete) to match Prisma deleteMany semantics.
   * Errors propagate to caller (required for proper error handling).
   */
  async deleteSession(id: string): Promise<boolean> {
    await this.sql`DELETE FROM "Session" WHERE id = ${id}`;
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    // Use IN ${sql(ids)} instead of ANY(${ids}) for fetch_types:false compatibility.
    // ANY() requires type info to serialize arrays correctly; sql() creates
    // a properly formatted parameter list that works without type lookup.
    await this.sql`DELETE FROM "Session" WHERE id IN ${this.sql(ids)}`;
    return true;
  }

  async findSessionsByShop(shop: string): Promise<ShopifySession[]> {
    const rows = await this.sql<SessionRow[]>`
      SELECT ${this.sql.unsafe(SELECT_COLUMNS)}
      FROM "Session"
      WHERE shop = ${shop}
    `;
    return rows.map((row) => this.rowToSession(row));
  }

  /**
   * Delete all sessions for a shop in a single query.
   * More efficient than findSessionsByShop + deleteSessions.
   * Returns the count of deleted sessions for logging.
   */
  async deleteAllForShop(shop: string): Promise<number> {
    const result = await this.sql`
      DELETE FROM "Session" WHERE shop = ${shop}
    `;
    return result.count;
  }

  /**
   * Update scope for all sessions of a shop (used by scopes_update webhook).
   * Returns the count of updated sessions.
   */
  async updateScopeForShop(shop: string, scope: string): Promise<number> {
    const result = await this.sql`
      UPDATE "Session" SET scope = ${scope} WHERE shop = ${shop}
    `;
    return result.count;
  }

  private sessionToRow(session: ShopifySession): Omit<SessionRow, "id" | "userId"> & { userId: bigint | null } {
    return {
      shop: session.shop,
      state: session.state,
      isOnline: session.isOnline,
      scope: session.scope ?? null,
      expires: session.expires ?? null,
      accessToken: session.accessToken ?? "",
      userId: session.onlineAccessInfo?.associated_user?.id
        ? BigInt(session.onlineAccessInfo.associated_user.id)
        : null,
      firstName: session.onlineAccessInfo?.associated_user?.first_name ?? null,
      lastName: session.onlineAccessInfo?.associated_user?.last_name ?? null,
      email: session.onlineAccessInfo?.associated_user?.email ?? null,
      accountOwner:
        session.onlineAccessInfo?.associated_user?.account_owner ?? false,
      locale: session.onlineAccessInfo?.associated_user?.locale ?? null,
      collaborator:
        session.onlineAccessInfo?.associated_user?.collaborator ?? false,
      emailVerified:
        session.onlineAccessInfo?.associated_user?.email_verified ?? false,
      refreshToken: session.refreshToken ?? null,
      refreshTokenExpires: session.refreshTokenExpires ?? null,
      needsReauth: false,
    };
  }

  private rowToSession(row: SessionRow): ShopifySession {
    const sessionData: ConstructorParameters<typeof ShopifySession>[0] = {
      id: row.id,
      shop: row.shop,
      state: row.state,
      isOnline: row.isOnline,
      scope: row.scope ?? undefined,
      expires: row.expires ?? undefined,
      accessToken: row.accessToken,
      refreshToken: row.refreshToken ?? undefined,
      refreshTokenExpires: row.refreshTokenExpires ?? undefined,
    };

    // userId is returned as string by postgres.js (int8 -> string)
    if (row.userId !== null) {
      sessionData.onlineAccessInfo = {
        expires_in: 0,
        associated_user_scope: row.scope ?? "",
        associated_user: {
          id: parseInt(row.userId, 10),
          first_name: row.firstName ?? "",
          last_name: row.lastName ?? "",
          email: row.email ?? "",
          account_owner: row.accountOwner,
          locale: row.locale ?? "",
          collaborator: row.collaborator,
          email_verified: row.emailVerified,
        },
      };
    }

    return new ShopifySession(sessionData);
  }
}

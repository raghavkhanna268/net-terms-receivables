/**
 * Kysely-based session storage for Shopify sessions.
 * 
 * EXPERIMENTAL: Alternative to PrismaSessionStorage with smaller bundle size.
 * 
 * This implements the same interface as PrismaSessionStorage but uses Kysely
 * for database operations. The bundle size reduction is significant:
 * - Prisma: ~4.4MB (including WASM query compiler)
 * - Kysely: ~50KB
 */

import { Session as ShopifySession } from "@shopify/shopify-api";
import type { KyselyDb, SessionTable } from "./db-kysely.server";

export type KyselyDbGetter = () => KyselyDb;

export class KyselySessionStorage {
  private getDb: KyselyDbGetter;

  constructor(dbOrGetter: KyselyDb | KyselyDbGetter) {
    this.getDb = typeof dbOrGetter === "function" ? dbOrGetter : () => dbOrGetter;
  }

  private get db(): KyselyDb {
    return this.getDb();
  }

  async storeSession(session: ShopifySession): Promise<boolean> {
    const data = this.sessionToRow(session);
    
    await this.db
      .insertInto("Session")
      .values({ id: session.id, ...data })
      .onConflict((oc) => oc.column("id").doUpdateSet(data))
      .execute();
    
    return true;
  }

  async loadSession(id: string): Promise<ShopifySession | undefined> {
    const row = await this.db
      .selectFrom("Session")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    if (!row) return undefined;
    return this.rowToSession(row);
  }

  async deleteSession(id: string): Promise<boolean> {
    await this.db
      .deleteFrom("Session")
      .where("id", "=", id)
      .execute();
    
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    
    await this.db
      .deleteFrom("Session")
      .where("id", "in", ids)
      .execute();
    
    return true;
  }

  async findSessionsByShop(shop: string): Promise<ShopifySession[]> {
    const rows = await this.db
      .selectFrom("Session")
      .selectAll()
      .where("shop", "=", shop)
      .execute();

    return rows.map((row) => this.rowToSession(row));
  }

  async deleteAllForShop(shop: string): Promise<number> {
    const result = await this.db
      .deleteFrom("Session")
      .where("shop", "=", shop)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }

  async updateScopeForShop(shop: string, scope: string): Promise<number> {
    const result = await this.db
      .updateTable("Session")
      .set({ scope })
      .where("shop", "=", shop)
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0);
  }

  private sessionToRow(session: ShopifySession): Omit<SessionTable, "id"> {
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
    };
  }

  private rowToSession(row: SessionTable): ShopifySession {
    const sessionData: ConstructorParameters<typeof ShopifySession>[0] = {
      id: row.id,
      shop: row.shop,
      state: row.state,
      isOnline: row.isOnline,
      scope: row.scope ?? undefined,
      expires: row.expires ? new Date(row.expires) : undefined,
      accessToken: row.accessToken,
      refreshToken: row.refreshToken ?? undefined,
      refreshTokenExpires: row.refreshTokenExpires 
        ? new Date(row.refreshTokenExpires) 
        : undefined,
    };

    if (row.userId !== null) {
      sessionData.onlineAccessInfo = {
        expires_in: 0,
        associated_user_scope: row.scope ?? "",
        associated_user: {
          id: Number(row.userId),
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

import { Session as ShopifySession } from "@shopify/shopify-api";
import type { PrismaClient, Session as PrismaSession } from "~/generated/prisma/client";

export type PrismaClientGetter = () => PrismaClient;

/**
 * Custom Prisma-based session storage for Shopify sessions.
 *
 * This replaces @shopify/shopify-app-session-storage-prisma to:
 * - Use the Prisma 7 generated client directly (runtime = cloudflare)
 * - Avoid the .prisma/client/default resolution issues in Workers
 * - Support lazy client creation via getter function
 * - Add deleteAllForShop for efficient bulk deletion (DPDP compliance)
 * - Skip readiness checks (Hyperdrive handles connection pooling)
 *
 * Two generators in schema.prisma:
 * - runtime = "cloudflare" for production Worker (app/generated/prisma)
 * - runtime = "nodejs" for tests (app/generated/prisma-node)
 */
export class PrismaSessionStorage {
  private getPrisma: PrismaClientGetter;

  constructor(prismaOrGetter: PrismaClient | PrismaClientGetter) {
    this.getPrisma =
      typeof prismaOrGetter === "function"
        ? prismaOrGetter
        : () => prismaOrGetter;
  }

  private get prisma(): PrismaClient {
    return this.getPrisma();
  }

  async storeSession(session: ShopifySession): Promise<boolean> {
    const data = this.sessionToRow(session);
    await this.prisma.session.upsert({
      where: { id: session.id },
      update: data,
      create: { id: session.id, ...data },
    });
    return true;
  }

  async loadSession(id: string): Promise<ShopifySession | undefined> {
    const row = await this.prisma.session.findUnique({ where: { id } });
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  async deleteSession(id: string): Promise<boolean> {
    await this.prisma.session.deleteMany({ where: { id } });
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    await this.prisma.session.deleteMany({ where: { id: { in: ids } } });
    return true;
  }

  async findSessionsByShop(shop: string): Promise<ShopifySession[]> {
    const rows = await this.prisma.session.findMany({ where: { shop } });
    return rows.map((row) => this.rowToSession(row));
  }

  /**
   * Delete all sessions for a shop in a single query.
   * More efficient than findSessionsByShop + deleteSessions and avoids
   * the default 25-session limit of findSessionsByShop.
   * Returns the count of deleted sessions for logging.
   */
  async deleteAllForShop(shop: string): Promise<number> {
    const result = await this.prisma.session.deleteMany({ where: { shop } });
    return result.count;
  }

  /**
   * Update scope for all sessions of a shop (used by scopes_update webhook).
   * Returns the count of updated sessions.
   */
  async updateScopeForShop(shop: string, scope: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { shop },
      data: { scope },
    });
    return result.count;
  }

  private sessionToRow(session: ShopifySession): Omit<PrismaSession, "id"> {
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

  private rowToSession(row: PrismaSession): ShopifySession {
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

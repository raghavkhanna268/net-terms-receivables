/**
 * PlanSource interface for S24 plan resolution abstraction.
 *
 * This module defines the interface for plan resolution sources, allowing
 * the app to resolve plans from different backends without changing callers.
 *
 * Current sources:
 * - AdminInstallationPlanSource: Reads currentAppInstallation.activeSubscriptions
 *   from Shopify Admin GraphQL (production implementation)
 * - PartnerApiPlanSource: STUB for future Shopify App Pricing via Partner API
 *   (not implemented, never selected)
 *
 * Design:
 * - Single selector always returns AdminInstallationPlanSource today
 * - No env var, credential, or config flag for source selection
 * - Interface allows future Partner API integration without touching callers
 *
 * @see https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
 * @see https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/migrating-to-shopify-app-pricing
 */

import type { Sql } from "~/lib/db-light.server";
import type { PlanConfig, PlanKey } from "~/lib/entitlements";

/**
 * Source tag identifying which backend resolved the plan.
 */
export type PlanSourceTag = "admin_installation" | "partner_api" | "not_configured";

/**
 * Status of plan resolution.
 */
export type PlanStatus = "active" | "expired" | "cancelled" | "pending" | "unknown";

/**
 * Discriminated resolution state for plan resolution results.
 *
 * - 'active': Confirmed active subscription from the source
 * - 'none': Confirmed no subscription (Partner API returned null, or Admin returned no ACTIVE sub)
 * - 'unknown': Fetch error, exception, or no Shop row yet
 *
 * Callers should only redirect to pricing on 'none'. Never redirect on 'unknown'
 * (that would kick paying merchants on transient errors).
 */
export type ResolutionState = "active" | "none" | "unknown";

/**
 * Result of plan resolution from a PlanSource.
 */
export interface SourceResolvedPlan {
  /** The resolved plan configuration */
  plan: PlanConfig;
  /** Internal plan key (free, starter, growth, scale) */
  planKey: PlanKey;
  /** Shopify subscription ID (GID) */
  subscriptionId: string | null;
  /** Shopify subscription name */
  subscriptionName: string | null;
  /** Whether this is a test subscription */
  isTest: boolean;
  /** Whether the result came from cache */
  fromCache: boolean;
  /** Which source resolved the plan */
  sourceTag: PlanSourceTag;
  /** Status of the subscription */
  status: PlanStatus;
  /**
   * Discriminated resolution state.
   * - 'active': Confirmed active subscription
   * - 'none': Confirmed no subscription
   * - 'unknown': Fetch error, exception, or no Shop row yet
   */
  resolutionState: ResolutionState;
}

/**
 * Context for plan resolution.
 */
export interface PlanResolutionContext {
  /** Postgres.js SQL client */
  sql: Sql;
  /** Shop domain (e.g., "example.myshopify.com") */
  shopDomain: string;
  /**
   * Internal shop ID (optional).
   * Reserved for future Partner API source which may receive shopId
   * from the post-checkout redirect instead of resolving from domain.
   * Currently unused by AdminInstallationPlanSource.
   */
  shopId?: string;
  /** Force refresh from source (skip cache) */
  forceRefresh?: boolean;
}

/**
 * Interface for plan resolution sources.
 *
 * Implementations resolve the active plan for a shop from their respective
 * backends (Admin GraphQL, Partner API, etc.).
 */
export interface PlanSource {
  /**
   * Resolve the active plan for a shop.
   *
   * @param ctx - Resolution context with SQL client and shop identifiers
   * @returns The resolved plan with source metadata
   */
  resolveActivePlan(ctx: PlanResolutionContext): Promise<SourceResolvedPlan>;

  /**
   * Optional hook called after a plan checkout redirect.
   *
   * Used by Partner API source to capture the plan_handle from the
   * post-checkout redirect URL and map it to internal plan keys.
   *
   * @param planHandle - The plan_handle query parameter from redirect
   * @returns The internal plan key, or null if handle is unknown
   */
  onPlanRedirect?(planHandle: string): PlanKey | null;
}

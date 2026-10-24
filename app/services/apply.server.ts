import type { Sql } from "~/lib/db-light.server";
import { shopifyGraphQLRequest, type ShopifyClientResult } from "./shopify-client.server";
import { enqueueRecomputeForInvoice } from "./credit-status-recompute.server";

const MUTATION = `mutation($input:OrderMarkAsPaidInput!){orderMarkAsPaid(input:$input){order{id}userErrors{message}}}`;

export interface ApplyMatchResult {
  success: boolean;
  invoicePaid: boolean;
  shopifyPushSucceeded: boolean;
  error?: string;
  retryable?: boolean;
  reasonCode?: string;
}

export interface UnmatchResult {
  success: boolean;
  error?: string;
  alreadyPushed?: boolean;
}

const FAIL = { success: false, invoicePaid: false, shopifyPushSucceeded: false } as const;
const OK = { success: true, invoicePaid: false, shopifyPushSucceeded: false } as const;

async function audit(tx: Sql, sid: string, actor: string, type: string, d: object) {
  await tx`INSERT INTO "AuditEvent" (id,"shopId",actor,type,data,at) VALUES (gen_random_uuid(),${sid},${actor},${type},${tx.json(d as never)}::jsonb,NOW())`;
}

async function claimMatch(tx: Sql, id: string): Promise<{ ok: boolean; state?: string }> {
  const [t] = await tx<{ id: string }[]>`UPDATE "Match" SET state='pushed',"updatedAt"=NOW() WHERE id=${id} AND state='confirmed' RETURNING id`;
  if (t) return { ok: true };
  const [c] = await tx<{ state: string }[]>`SELECT state FROM "Match" WHERE id=${id}`;
  return { ok: false, state: c?.state };
}

export async function applyMatch(sql: Sql, matchId: string, actor: string): Promise<ApplyMatchResult> {
  const [m] = await sql<{ id: string; shop_id: string; payment_id: string; invoice_id: string; amt: string; state: string }[]>`
    SELECT id,"shopId" AS shop_id,"paymentId" AS payment_id,"invoiceId" AS invoice_id,(ROUND(amount*100))::text AS amt,state FROM "Match" WHERE id=${matchId}`;
  if (!m) return { ...FAIL, error: "Match not found" };
  if (m.state === "pushed") return { ...OK, reasonCode: "ALREADY_APPLIED" };
  if (m.state !== "confirmed") return { ...FAIL, error: `State '${m.state}' not confirmed` };

  const [inv] = await sql<{ id: string; out: string; oid: string | null; dom: string; ba: string }[]>`
    SELECT i.id,(ROUND(i.outstanding*100))::text AS out,i."orderId" AS oid,s.domain AS dom,i."buyerAccountId" AS ba FROM "Invoice" i JOIN "Shop" s ON s.id=i."shopId" WHERE i.id=${m.invoice_id}`;
  if (!inv) return { ...FAIL, error: "Invoice not found" };

  const mAmt = BigInt(m.amt), iOut = BigInt(inv.out);
  const red = mAmt > iOut ? iOut : mAmt;
  const newOut = iOut - red;
  const isFull = newOut === 0n;

  if (!isFull) {
    try {
      const res = await sql.begin(async (tx) => {
        const [loc] = await tx<{ out: string; st: string }[]>`SELECT (ROUND(outstanding*100))::text AS out,status AS st FROM "Invoice" WHERE id=${inv.id} FOR UPDATE`;
        if (!loc || loc.st !== "open") throw new Error(loc ? `Invoice is '${loc.st}'` : "Invoice not found");
        const claim = await claimMatch(tx, matchId);
        if (!claim.ok) {
          if (claim.state === "pushed") return { dup: true };
          throw new Error(`Match is in '${claim.state ?? "unknown"}' state`);
        }
        const cur = BigInt(loc.out), fin = cur - red;
        if (fin < 0n) throw new Error("Exceeds outstanding");
        await tx`UPDATE "Invoice" SET outstanding=${Number(fin)/100},"updatedAt"=NOW() WHERE id=${inv.id}`;
        await audit(tx, m.shop_id, actor, "match.applied", { matchId, invoiceId: inv.id, paymentId: m.payment_id, amtP: red.toString(), prevP: cur.toString(), newP: fin.toString() });
        return { dup: false, iid: inv.id };
      });
      if (res.dup) return { ...OK, reasonCode: "ALREADY_APPLIED" };
      try { await enqueueRecomputeForInvoice(sql, res.iid!); } catch { /* ok */ }
      return { ...OK };
    } catch (e) { return { ...FAIL, error: e instanceof Error ? e.message : String(e) }; }
  }

  let transitioned = false;
  try {
    const claimed = await sql.begin(async (tx) => {
      const c = await claimMatch(tx, matchId);
      if (!c.ok && c.state === "pushed") return { dup: true };
      if (!c.ok) throw new Error(`Match is in '${c.state ?? "unknown"}' state`);
      return { dup: false };
    });
    if (claimed.dup) return { ...OK, reasonCode: "ALREADY_APPLIED" };
    transitioned = true;
  } catch (e) { return { ...FAIL, error: e instanceof Error ? e.message : String(e) }; }

  let shopOk = false, rc: string | undefined;
  if (inv.oid) {
    const sr = await callShopify(inv.dom, inv.oid);
    if (sr.success) shopOk = true;
    else if (sr.alreadyPaid) { shopOk = true; rc = "ALREADY_PAID_IN_SHOPIFY"; }
    else {
      try { await sql`UPDATE "Match" SET state='confirmed',"updatedAt"=NOW() WHERE id=${matchId} AND state='pushed'`; } catch { /* ok */ }
      return { ...FAIL, error: sr.error ?? "Shopify failed", retryable: sr.retryable };
    }
  } else shopOk = true;

  try {
    await sql.begin(async (tx) => {
      const [loc] = await tx<{ out: string }[]>`SELECT (ROUND(outstanding*100))::text AS out FROM "Invoice" WHERE id=${inv.id} FOR UPDATE`;
      if (!loc) throw new Error("Invoice not found");
      const prev = loc.out;
      await tx`UPDATE "Invoice" SET outstanding=0,status='paid',"updatedAt"=NOW() WHERE id=${inv.id}`;
      if (transitioned) {
        await audit(tx, m.shop_id, actor, "match.applied", { matchId, invoiceId: inv.id, paymentId: m.payment_id, amtP: m.amt, prevP: prev, newP: "0", rc });
        await audit(tx, m.shop_id, actor, "invoice.paid", { invoiceId: inv.id, matchId, orderGid: inv.oid, pushed: shopOk, rc });
      }
    });
  } catch (e) { return { success: false, invoicePaid: false, shopifyPushSucceeded: shopOk, error: `DB: ${e instanceof Error ? e.message : String(e)}` }; }

  try { await enqueueRecomputeForInvoice(sql, inv.id); } catch { /* ok */ }
  return { success: true, invoicePaid: true, shopifyPushSucceeded: shopOk, reasonCode: rc };
}

export async function unmatchMatch(sql: Sql, matchId: string, actor: string): Promise<UnmatchResult> {
  try {
    const res = await sql.begin(async (tx) => {
      const [m] = await tx<{ id: string; sid: string; pid: string; iid: string; amt: string; st: string }[]>`
        SELECT id,"shopId" AS sid,"paymentId" AS pid,"invoiceId" AS iid,(ROUND(amount*100))::text AS amt,state AS st FROM "Match" WHERE id=${matchId} FOR UPDATE`;
      if (!m) return { success: false, error: "Match not found" };
      if (m.st === "unmatched" || m.st === "suggested") return { success: true };
      if (m.st === "pushed") {
        const [inv] = await tx<{ out: string; st: string }[]>`SELECT (ROUND(outstanding*100))::text AS out,status AS st FROM "Invoice" WHERE id=${m.iid} FOR UPDATE`;
        if (!inv) return { success: false, error: "Invoice not found" };
        if (inv.st === "paid") return { success: false, error: "Order paid in Shopify", alreadyPushed: true };
        const [tr] = await tx<{ id: string }[]>`UPDATE "Match" SET state='unmatched',"updatedAt"=NOW() WHERE id=${matchId} AND state='pushed' RETURNING id`;
        if (tr) {
          const nOut = BigInt(inv.out) + BigInt(m.amt);
          await tx`UPDATE "Invoice" SET outstanding=${Number(nOut)/100},"updatedAt"=NOW() WHERE id=${m.iid}`;
          await audit(tx, m.sid, actor, "match.unmatched", { matchId: m.id, invoiceId: m.iid, paymentId: m.pid, amtP: m.amt, prev: "pushed" });
          return { success: true, iid: m.iid };
        }
        return { success: true };
      }
      const [tr] = await tx<{ id: string }[]>`UPDATE "Match" SET state='unmatched',"updatedAt"=NOW() WHERE id=${matchId} AND state='confirmed' RETURNING id`;
      if (tr) {
        await audit(tx, m.sid, actor, "match.unmatched", { matchId: m.id, invoiceId: m.iid, paymentId: m.pid, amtP: m.amt, prev: "confirmed" });
        const [cc] = await tx<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM "Match" WHERE "paymentId"=${m.pid} AND state IN ('confirmed','pushed')`;
        if (parseInt(cc?.c ?? "0", 10) === 0) {
          const [sc] = await tx<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM "Match" WHERE "paymentId"=${m.pid} AND state='suggested'`;
          await tx`UPDATE "Payment" SET status=${parseInt(sc?.c ?? "0", 10) > 0 ? "partial" : "unmatched"},"updatedAt"=NOW() WHERE id=${m.pid}`;
        }
      }
      return { success: true };
    });
    if (res.success && "iid" in res && res.iid) { try { await enqueueRecomputeForInvoice(sql, res.iid); } catch { /* ok */ } }
    return res;
  } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
}

export const unmatchPushedMatch = unmatchMatch;

async function callShopify(dom: string, gid: string): Promise<{ success: boolean; alreadyPaid?: boolean; error?: string; retryable?: boolean }> {
  const r: ShopifyClientResult<{ orderMarkAsPaid: { order: { id: string } | null; userErrors: { message: string }[] } }> = await shopifyGraphQLRequest(dom, MUTATION, { input: { id: gid } });
  if (!r.success) return { success: false, error: r.error ?? "Request failed", retryable: r.retryable };
  const d = r.data?.orderMarkAsPaid;
  if (!d) return { success: false, error: "Invalid response", retryable: true };
  if (d.userErrors.length) {
    const msg = d.userErrors.map((e) => e.message).join("; ").toLowerCase();
    if (msg.includes("paid")) return { success: false, alreadyPaid: true };
    return { success: false, error: msg };
  }
  return { success: true };
}

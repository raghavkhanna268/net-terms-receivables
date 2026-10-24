import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ActionFunctionArgs,
} from "react-router";
import { useLoaderData, useNavigation, Form } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import {
  getUnmatchedPayments,
  getSuggestedMatches,
  getPaymentWithMatches,
} from "~/lib/matching/queries.server";
import {
  runMatcher,
  confirmMatch,
  rejectMatch,
  MAX_PAYMENTS_PER_REQUEST,
} from "~/services/matcher.server";
import { applyMatch, unmatchMatch } from "~/services/apply.server";
import { formatPaiseAmount } from "~/lib/aging";
import { resolvePlan } from "~/services/plan.server";
import { isGatingEnforced } from "~/services/gating.server";
import type { PlanKey } from "~/lib/entitlements";
import { UpgradePrompt } from "~/components/UpgradePrompt";

const PAGE_SIZE = 20;

interface PaymentSummary {
  id: string;
  amountPaise: string;
  narration: string;
  payerText: string | null;
  utr: string | null;
  rail: string | null;
}

interface MatchSummary {
  id: string;
  paymentId: string;
  invoiceId: string;
  invoiceName: string;
  amountPaise: string;
  score: number;
  reasons: unknown;
  state: string;
  buyerName: string;
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const view = url.searchParams.get("view") ?? "suggested";
  const selectedPaymentId = url.searchParams.get("payment") ?? null;

  // Get shop ID
  const [shop] = await sql<{ id: string; currency: string }[]>`
    SELECT id, currency FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return {
      shopCurrency: "INR",
      payments: [],
      matches: [],
      selectedPayment: null,
      pagination: { page: 1, pageSize: PAGE_SIZE, totalCount: 0 },
      view,
      error: "Shop not found",
      tabCounts: { suggested: 0, unmatched: 0, confirmed: 0 },
      planKey: "free" as PlanKey,
      gatingEnforced: false,
      storeHandle: shopDomain.replace(".myshopify.com", ""),
      appHandle: process.env.APP_HANDLE ?? "net-terms-receivables",
    };
  }

  const gatingEnforced = isGatingEnforced();
  const storeHandle = shopDomain.replace(".myshopify.com", "");

  let payments: PaymentSummary[] = [];
  let matches: MatchSummary[] = [];
  let selectedPayment: {
    payment: PaymentSummary & { valueDate: string; importFileName: string };
    matches: MatchSummary[];
  } | null = null;
  let totalCount = 0;

  let tabCounts = { suggested: 0, unmatched: 0, confirmed: 0 };
  let planData = { plan: { key: "free" as PlanKey } };
  try {
    const [pR, sC, uC] = await Promise.all([resolvePlan(sql, shopDomain), sql<{c:string}[]>`SELECT COUNT(*)::text AS c FROM "Match" WHERE "shopId"=${shop.id} AND state='suggested'`.then(r=>r[0]), sql<{c:string}[]>`SELECT COUNT(*)::text AS c FROM "Payment" WHERE "shopId"=${shop.id} AND status IN ('unmatched','partial')`.then(r=>r[0])]);
    planData = pR; tabCounts = { suggested: parseInt(sC?.c??"0",10), unmatched: parseInt(uC?.c??"0",10), confirmed: 0 };
  } catch { /* continue */ }

  const mm = (m:{id:string,paymentId:string,invoiceId:string,invoiceName:string,amountPaise:bigint,score:number,reasons:unknown,state:string,buyerName:string})=>({id:m.id,paymentId:m.paymentId,invoiceId:m.invoiceId,invoiceName:m.invoiceName,amountPaise:m.amountPaise.toString(),score:m.score,reasons:m.reasons,state:m.state,buyerName:m.buyerName});
  try {
    if (selectedPaymentId) {
      const pd = await getPaymentWithMatches(sql, shop.id, selectedPaymentId);
      if (pd) { const p = pd.payment; selectedPayment = { payment: { id: p.id, amountPaise: p.amountPaise.toString(), narration: p.narration, payerText: p.payerText, utr: p.utr, rail: p.rail, valueDate: p.valueDate.toISOString(), importFileName: p.importFileName }, matches: pd.matches.map(m=>({...mm({...m,paymentId:selectedPaymentId})})) }; }
    } else if (view === "unmatched") {
      const r = await getUnmatchedPayments(sql, shop.id, { limit: PAGE_SIZE, offset: (page-1)*PAGE_SIZE });
      payments = r.payments.map(p => ({ id: p.id, amountPaise: p.amountPaise.toString(), narration: p.narration, payerText: p.payerText, utr: p.utr, rail: p.rail })); totalCount = r.totalCount;
    } else if (view === "confirmed") {
      const r = await getSuggestedMatches(sql, shop.id, { limit: PAGE_SIZE, offset: (page-1)*PAGE_SIZE, state: "confirmed" }); matches = r.matches.map(mm); totalCount = r.totalCount; tabCounts.confirmed = totalCount;
    } else {
      const r = await getSuggestedMatches(sql, shop.id, { limit: PAGE_SIZE, offset: (page-1)*PAGE_SIZE, state: "suggested" }); matches = r.matches.map(mm); totalCount = r.totalCount;
    }
  } catch { return { shopCurrency: shop.currency, payments: [], matches: [], selectedPayment: null, pagination: { page, pageSize: PAGE_SIZE, totalCount: 0 }, view, error: "Load failed", tabCounts, planKey: planData.plan.key, gatingEnforced, storeHandle, appHandle: process.env.APP_HANDLE ?? "net-terms-receivables" }; }
  return { shopCurrency: shop.currency, payments, matches, selectedPayment, pagination: { page, pageSize: PAGE_SIZE, totalCount }, view, error: null, tabCounts, planKey: planData.plan.key, gatingEnforced, storeHandle, appHandle: process.env.APP_HANDLE ?? "net-terms-receivables" };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);
  const sql = getRequestSql();
  const shopDomain = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Get shop ID
  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return { success: false, error: "Shop not found" };
  }

  const userId = session.onlineAccessInfo?.associatedUser?.id?.toString() ?? "system";

  try {
    switch (intent) {
      case "run_matcher": {
        const r = await runMatcher(sql, shop.id, { limit: MAX_PAYMENTS_PER_REQUEST });
        return { success: true, message: `${r.paymentsProcessed} payments, ${r.matchesCreated} matches (${r.highConfidenceMatches} high)${r.hasMore?" (more)":""}` };
      }
      case "confirm": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) return { success: false, error: "Match ID required" };
        const r = await confirmMatch(sql, shop.id, matchId, userId);
        return { success: r.success, error: r.success ? null : "Confirm failed" };
      }
      case "reject": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) return { success: false, error: "Match ID required" };
        const r = await rejectMatch(sql, shop.id, matchId, userId);
        return { success: r.success, error: r.success ? null : "Reject failed" };
      }
      case "apply": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) return { success: false, error: "Match ID required" };
        const r = await applyMatch(sql, matchId, userId);
        return { success: r.success, error: r.success ? null : (r.error ?? "Apply failed") };
      }
      case "unmatch": {
        const matchId = formData.get("matchId") as string;
        if (!matchId) return { success: false, error: "Match ID required" };
        const r = await unmatchMatch(sql, matchId, userId);
        return { success: r.success, error: r.success ? null : (r.error ?? "Unmatch failed") };
      }
      default: return { success: false, error: "Unknown" };
    }
  } catch (err) {
    console.error("[reconcile] action:", err);
    return { success: false, error: "Failed" };
  }
};

function ScoreBadge({score}:{score:number}) {
  const t = score>=80?"success":score>=50?"warning":"critical", l = score>=80?"Hi":score>=50?"Med":"Lo";
  return <s-badge tone={t}>{l} ({score})</s-badge>;
}
function RailBadge({rail}:{rail:string|null}) {
  if (!rail) return <s-text>—</s-text>;
  const t = rail==="NEFT"?"info":rail==="RTGS"?"success":rail==="IMPS"?"warning":undefined;
  return t ? <s-badge tone={t}>{rail}</s-badge> : <s-badge>{rail}</s-badge>;
}
function MatchReasons({reasons}:{reasons:unknown}) {
  return Array.isArray(reasons)?<s-text>{reasons.map(r=>`${r.type}+${r.points}`).join(", ")}</s-text>:null;
}

function PaymentDetailView({ payment, matches, currency }: { payment: { id: string; amountPaise: string; narration: string; payerText: string | null; utr: string | null; rail: string | null; valueDate: string; importFileName: string }; matches: MatchSummary[]; currency: string }) {
  const nav = useNavigation(), dis = nav.state === "submitting";
  const P = ({l,v}:{l:string,v:unknown})=><s-paragraph><s-text type="strong">{l}: </s-text><s-text>{v as string}</s-text></s-paragraph>;
  return (<s-section heading="Payment Details"><s-stack>
    <P l="Amount" v={formatPaiseAmount(BigInt(payment.amountPaise), currency)}/><P l="Date" v={new Date(payment.valueDate).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata"})}/>
    <s-paragraph><s-text type="strong">Rail: </s-text><RailBadge rail={payment.rail}/></s-paragraph>
    {payment.utr && <P l="UTR" v={payment.utr}/>}{payment.payerText && <P l="Payer" v={payment.payerText}/>}
    <P l="Narration" v={payment.narration}/><P l="Import" v={payment.importFileName}/><s-divider/>
    <s-paragraph><s-text type="strong">Matches ({matches.length})</s-text></s-paragraph>
    {!matches.length ? <s-empty-state heading="None"><s-text slot="subheading">No matches. Run matcher.</s-text></s-empty-state> : <s-table><s-table-header-row><s-table-header>Invoice</s-table-header><s-table-header>Buyer</s-table-header><s-table-header format="currency">Amt</s-table-header><s-table-header>Score</s-table-header><s-table-header>Reasons</s-table-header><s-table-header>Actions</s-table-header></s-table-header-row><s-table-body>
    {matches.map(m=>(<s-table-row key={m.id}><s-table-cell>{m.invoiceName}</s-table-cell><s-table-cell>{m.buyerName}</s-table-cell><s-table-cell>{formatPaiseAmount(BigInt(m.amountPaise),currency)}</s-table-cell><s-table-cell><ScoreBadge score={m.score}/></s-table-cell><s-table-cell><MatchReasons reasons={m.reasons}/></s-table-cell><s-table-cell>{m.state==="suggested"?<s-stack direction="inline"><Form method="post"><input type="hidden" name="intent" value="confirm"/><input type="hidden" name="matchId" value={m.id}/><s-button variant="primary" type="submit" disabled={dis}>Confirm</s-button></Form><Form method="post"><input type="hidden" name="intent" value="reject"/><input type="hidden" name="matchId" value={m.id}/><s-button variant="secondary" tone="critical" type="submit" disabled={dis}>Reject</s-button></Form></s-stack>:<s-badge tone={m.state==="confirmed"?"success":"critical"}>{m.state}</s-badge>}</s-table-cell></s-table-row>))}
    </s-table-body></s-table>}<s-button href="/app/reconcile">Back</s-button>
  </s-stack></s-section>);
}

function UnmatchedPaymentsView({payments,currency,page,totalCount,pageSize}:{payments:PaymentSummary[];currency:string;page:number;totalCount:number;pageSize:number}) {
  const tp = Math.ceil(totalCount/pageSize), tr = (s:string,n:number)=>s.length>n?s.slice(0,n)+"…":s;
  if (!payments.length) return <s-empty-state heading="None"><s-text slot="subheading">All matched. Import statements.</s-text></s-empty-state>;
  return (<s-stack><s-table><s-table-header-row><s-table-header format="currency">Amt</s-table-header><s-table-header>Rail</s-table-header><s-table-header>UTR</s-table-header><s-table-header>Payer</s-table-header><s-table-header>Narration</s-table-header><s-table-header>Act</s-table-header></s-table-header-row><s-table-body>
  {payments.map(p=>(<s-table-row key={p.id}><s-table-cell>{formatPaiseAmount(BigInt(p.amountPaise),currency)}</s-table-cell><s-table-cell><RailBadge rail={p.rail}/></s-table-cell><s-table-cell>{p.utr??"—"}</s-table-cell><s-table-cell>{p.payerText?tr(p.payerText,30):"—"}</s-table-cell><s-table-cell>{tr(p.narration,40)}</s-table-cell><s-table-cell><s-link href={`/app/reconcile?payment=${p.id}`}>View</s-link></s-table-cell></s-table-row>))}
  </s-table-body></s-table>{tp>1&&<s-stack direction="inline">{page>1&&<s-button href={`/app/reconcile?view=unmatched&page=${page-1}`}>Prev</s-button>}<s-text>Page {page}/{tp} ({totalCount})</s-text>{page<tp&&<s-button href={`/app/reconcile?view=unmatched&page=${page+1}`}>Next</s-button>}</s-stack>}</s-stack>);
}

function SuggestedMatchesView({matches,currency,page,totalCount,pageSize}:{matches:MatchSummary[];currency:string;page:number;totalCount:number;pageSize:number}) {
  const nav=useNavigation(),dis=nav.state==="submitting",tp=Math.ceil(totalCount/pageSize);
  if (!matches.length) return <s-empty-state heading="None"><s-text slot="subheading">No suggestions. Run matcher.</s-text></s-empty-state>;
  return (<s-stack><s-table><s-table-header-row><s-table-header>Invoice</s-table-header><s-table-header>Buyer</s-table-header><s-table-header format="currency">Amt</s-table-header><s-table-header>Score</s-table-header><s-table-header>Actions</s-table-header></s-table-header-row><s-table-body>
  {matches.map(m=>(<s-table-row key={m.id}><s-table-cell>{m.invoiceName}</s-table-cell><s-table-cell>{m.buyerName}</s-table-cell><s-table-cell>{formatPaiseAmount(BigInt(m.amountPaise),currency)}</s-table-cell><s-table-cell><ScoreBadge score={m.score}/></s-table-cell><s-table-cell><s-stack direction="inline"><s-link href={`/app/reconcile?payment=${m.paymentId}`}>Details</s-link><Form method="post" style={{display:"inline"}}><input type="hidden" name="intent" value="confirm"/><input type="hidden" name="matchId" value={m.id}/><s-button variant="primary" type="submit" disabled={dis}>Confirm</s-button></Form><Form method="post" style={{display:"inline"}}><input type="hidden" name="intent" value="reject"/><input type="hidden" name="matchId" value={m.id}/><s-button variant="secondary" tone="critical" type="submit" disabled={dis}>Reject</s-button></Form></s-stack></s-table-cell></s-table-row>))}
  </s-table-body></s-table>{tp>1&&<s-stack direction="inline">{page>1&&<s-button href={`/app/reconcile?view=suggested&page=${page-1}`}>Prev</s-button>}<s-text>Page {page}/{tp} ({totalCount})</s-text>{page<tp&&<s-button href={`/app/reconcile?view=suggested&page=${page+1}`}>Next</s-button>}</s-stack>}</s-stack>);
}

export default function ReconcilePage() {
  const {
    shopCurrency,
    payments,
    matches,
    selectedPayment,
    pagination,
    view,
    error,
    tabCounts,
    planKey,
    gatingEnforced,
    storeHandle,
    appHandle,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const upgradeUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;

  return (
    <s-page heading="Payment Reconciliation">
      {error && (
        <s-section>
          <s-banner tone="critical" heading="Error">
            {error}
          </s-banner>
        </s-section>
      )}

      {planKey === "free" && (
        <s-section>
          <UpgradePrompt
            currentPlan={planKey}
            feature="matching"
            gatingEnforced={gatingEnforced}
            upgradeUrl={upgradeUrl}
          />
        </s-section>
      )}

      <s-section><s-stack direction="inline">
        <Form method="post"><input type="hidden" name="intent" value="run_matcher"/><s-button variant="primary" type="submit" disabled={isSubmitting}>{isSubmitting?"Running…":"Run Matcher"}</s-button></Form>
        <s-button href="/app/reconcile?view=suggested" variant={view==="suggested"?"primary":"secondary"}>Suggested ({tabCounts.suggested})</s-button>
        <s-button href="/app/reconcile?view=unmatched" variant={view==="unmatched"?"primary":"secondary"}>Unmatched ({tabCounts.unmatched})</s-button>
        <s-button href="/app/reconcile?view=confirmed" variant={view==="confirmed"?"primary":"secondary"}>Confirmed ({tabCounts.confirmed})</s-button>
      </s-stack></s-section>

      {selectedPayment ? <PaymentDetailView payment={selectedPayment.payment} matches={selectedPayment.matches} currency={shopCurrency}/> : view==="unmatched" ? (
        <s-section heading="Unmatched"><UnmatchedPaymentsView payments={payments} currency={shopCurrency} page={pagination.page} totalCount={pagination.totalCount} pageSize={pagination.pageSize}/></s-section>
      ) : view==="confirmed" ? (
        <s-section heading="Confirmed">
          {!matches.length ? <s-empty-state heading="None"><s-text slot="subheading">Confirm matches first.</s-text></s-empty-state> : (
            <s-table><s-table-header-row><s-table-header>Invoice</s-table-header><s-table-header>Buyer</s-table-header><s-table-header format="currency">Amount</s-table-header><s-table-header>Actions</s-table-header></s-table-header-row><s-table-body>
              {matches.map((m) => (<s-table-row key={m.id}><s-table-cell>{m.invoiceName}</s-table-cell><s-table-cell>{m.buyerName}</s-table-cell><s-table-cell>{formatPaiseAmount(BigInt(m.amountPaise), shopCurrency)}</s-table-cell><s-table-cell>
                <Form method="post" style={{display:"inline"}}><input type="hidden" name="intent" value="apply"/><input type="hidden" name="matchId" value={m.id}/><s-button variant="primary" type="submit" disabled={isSubmitting}>Apply</s-button></Form>{" "}
                <Form method="post" style={{display:"inline"}}><input type="hidden" name="intent" value="unmatch"/><input type="hidden" name="matchId" value={m.id}/><s-button variant="secondary" tone="critical" type="submit" disabled={isSubmitting}>Unmatch</s-button></Form>
              </s-table-cell></s-table-row>))}
            </s-table-body></s-table>)}
        </s-section>
      ) : <s-section heading="Suggested"><SuggestedMatchesView matches={matches} currency={shopCurrency} page={pagination.page} totalCount={pagination.totalCount} pageSize={pagination.pageSize}/></s-section>}

      <s-section slot="aside" heading="Help">
        <s-paragraph>Run Matcher finds matches. Apply reduces outstanding. Unmatch reverts. Scores: ref +30, amount +20. 80+ = high.</s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

/**
 * Name normalization for payment matching.
 *
 * Normalizes payer names, company names, and creates matchable tokens.
 * Used to create PayerAlias entries and match payment narrations to buyers.
 */

/**
 * Common company suffixes to remove (Indian business context).
 */
const COMPANY_SUFFIXES = [
  "PVT",
  "PRIVATE",
  "LTD",
  "LIMITED",
  "LLC",
  "LLP",
  "INC",
  "INCORPORATED",
  "CORP",
  "CORPORATION",
  "CO",
  "COMPANY",
  "ENTERPRISES",
  "ENTERPRISE",
  "TRADERS",
  "TRADING",
  "INDUSTRIES",
  "SOLUTIONS",
  "SERVICES",
  "TECHNOLOGIES",
  "TECH",
];

/**
 * Common prefixes to remove.
 */
const COMPANY_PREFIXES = [
  "M/S",
  "MS",
  "MESSRS",
  "SHRI",
  "SMT",
  "MR",
  "MRS",
  "DR",
  "PROF",
  "THE",
];

/**
 * Words to remove from normalized names.
 */
const STOP_WORDS = new Set([
  "AND",
  "OF",
  "THE",
  "FOR",
  "WITH",
  "IN",
  "AT",
  "TO",
  "FROM",
]);

/**
 * Normalize a name for matching.
 * Returns a lowercase string with suffixes/prefixes removed and normalized whitespace.
 */
export function normalizeName(name: string): string {
  let normalized = name.toUpperCase().trim();

  // Remove prefixes
  for (const prefix of COMPANY_PREFIXES) {
    const prefixPattern = new RegExp(`^${prefix}\\.?\\s*`, "i");
    normalized = normalized.replace(prefixPattern, "");
  }

  // Remove suffixes
  for (const suffix of COMPANY_SUFFIXES) {
    const suffixPattern = new RegExp(`\\b${suffix}\\.?\\b`, "gi");
    normalized = normalized.replace(suffixPattern, "");
  }

  // Remove punctuation
  normalized = normalized.replace(/[.,\-_()'"]/g, " ");

  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized.toLowerCase();
}

/**
 * Extract tokens from a normalized name.
 * Returns unique tokens >= 2 characters, excluding stop words.
 */
export function extractTokens(normalizedName: string): string[] {
  const words = normalizedName.toUpperCase().split(/\s+/);
  const tokens: string[] = [];

  for (const word of words) {
    if (word.length >= 2 && !STOP_WORDS.has(word)) {
      if (!tokens.includes(word.toLowerCase())) {
        tokens.push(word.toLowerCase());
      }
    }
  }

  return tokens;
}

/**
 * Generate payer alias keys from a company/buyer name.
 * Returns array of possible alias keys for the PayerAlias table.
 */
export function generateAliasKeys(name: string): string[] {
  const normalized = normalizeName(name);
  const tokens = extractTokens(normalized);
  const keys: string[] = [];

  // Full normalized name
  if (normalized.length >= 3) {
    keys.push(normalized);
  }

  // Individual significant tokens (>= 4 chars)
  for (const token of tokens) {
    if (token.length >= 4 && !keys.includes(token)) {
      keys.push(token);
    }
  }

  // First two tokens combined (common pattern: "ACME CORP" -> "acme corp")
  if (tokens.length >= 2) {
    const twoTokens = `${tokens[0]} ${tokens[1]}`;
    if (!keys.includes(twoTokens)) {
      keys.push(twoTokens);
    }
  }

  return keys;
}

/**
 * Normalize a narration/payer text for alias lookup.
 */
export function normalizeNarrationForLookup(narration: string): string {
  // Convert to uppercase
  let text = narration.toUpperCase();

  // Remove rail prefixes and common patterns
  text = text.replace(/^(NEFT|RTGS|IMPS|UPI|ACH|NACH|CHQ|CHEQUE|CLG)[\s\-/]*/gi, "");

  // Remove CR/DR indicators
  text = text.replace(/\b(CR|DR)\b/gi, "");

  // Remove UTR/RRN patterns (keep as separate step)
  text = text.replace(/[A-Z]{4}[NR]\d{11,17}/g, "");
  text = text.replace(/\b\d{12}\b/g, "");

  // Remove IFSC codes
  text = text.replace(/[A-Z]{4}0[A-Z0-9]{6}/g, "");

  // Extract potential name parts
  const parts = text.split(/[\s\-/]+/);
  const nameParts: string[] = [];

  for (const part of parts) {
    // Skip purely numeric parts, very short parts, and common banking terms
    if (
      /^\d+$/.test(part) ||
      part.length < 3 ||
      ["REF", "TRF", "TRANSFER", "PAYMENT", "SALARY", "INVOICE"].includes(part)
    ) {
      continue;
    }
    nameParts.push(part);
  }

  // Normalize and return
  return normalizeName(nameParts.join(" "));
}

/**
 * Calculate similarity between two normalized names.
 * Returns a score between 0 and 1.
 */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // Check for containment
  if (a.includes(b) || b.includes(a)) {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    return shorter.length / longer.length;
  }

  // Token-based Jaccard similarity
  const tokensA = new Set(a.split(/\s+/).filter((t) => t.length >= 2));
  const tokensB = new Set(b.split(/\s+/).filter((t) => t.length >= 2));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Buyer data shape for matching functions */
type BuyerForMatching = {
  id: string;
  name: string;
  aliases: string[];
  email: string | null;
};

/** Minimum score threshold for a valid buyer match */
const BUYER_MATCH_THRESHOLD = 0.5;

/**
 * Compute the match score for a single buyer against a normalized payer text.
 * Returns the best score across aliases, name similarity, and email prefix.
 * Internal helper used by both findBestBuyerMatch and findAllTiedBuyerMatches.
 */
function computeBuyerScore(
  normalizedPayer: string,
  buyer: BuyerForMatching
): number {
  let bestScore = 0;

  for (const alias of buyer.aliases) {
    if (alias === normalizedPayer || normalizedPayer.includes(alias)) {
      const score = alias === normalizedPayer ? 1 : 0.9;
      bestScore = Math.max(bestScore, score);
    }
  }

  const normalizedBuyerName = normalizeName(buyer.name);
  const nameSim = nameSimilarity(normalizedPayer, normalizedBuyerName);
  if (nameSim > BUYER_MATCH_THRESHOLD) {
    bestScore = Math.max(bestScore, nameSim);
  }

  if (buyer.email) {
    const emailPrefix = buyer.email.split("@")[0].toLowerCase();
    if (normalizedPayer.includes(emailPrefix) && emailPrefix.length >= 4) {
      bestScore = Math.max(bestScore, 0.7);
    }
  }

  return bestScore;
}

/**
 * Find the best matching buyer from a list based on payer text.
 * Returns the buyer ID and match score, or null if no good match.
 * Uses strict '>' comparison so ties go to the first buyer in input order.
 */
export function findBestBuyerMatch(
  payerText: string,
  buyers: Array<BuyerForMatching>
): { buyerId: string; score: number } | null {
  const normalizedPayer = normalizeNarrationForLookup(payerText);
  if (normalizedPayer.length < 3) return null;

  let bestMatch: { buyerId: string; score: number } | null = null;

  for (const buyer of buyers) {
    const score = computeBuyerScore(normalizedPayer, buyer);
    if (score >= BUYER_MATCH_THRESHOLD && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { buyerId: buyer.id, score };
    }
  }

  return bestMatch;
}

/**
 * Find ALL buyers tied with the best score for a given payer text.
 * Preserves the input array order (createdAt) for tie-breaking by caller.
 * Returns an empty array if no buyer meets the 0.5 threshold.
 */
export function findAllTiedBuyerMatches(
  payerText: string,
  buyers: Array<BuyerForMatching>
): Array<{ buyerId: string; score: number }> {
  const normalizedPayer = normalizeNarrationForLookup(payerText);
  if (normalizedPayer.length < 3) return [];

  const buyerScores: Array<{ buyerId: string; score: number }> = [];

  for (const buyer of buyers) {
    const score = computeBuyerScore(normalizedPayer, buyer);
    if (score >= BUYER_MATCH_THRESHOLD) {
      buyerScores.push({ buyerId: buyer.id, score });
    }
  }

  if (buyerScores.length === 0) return [];

  const topScore = Math.max(...buyerScores.map((b) => b.score));
  return buyerScores.filter((b) => b.score === topScore);
}

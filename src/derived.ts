/**
 * Derived/normalized fields that lift per-listing math the caller was
 * otherwise redoing dozens of times per session. Centralized here so
 * properties / compare / search / history all use the same formulas.
 *
 * Issues covered:
 *   - #34: hoa_monthly_usd (Annually / Quarterly / SemiAnnually / Weekly → USD/month)
 *   - #35: price_drop_amount + price_drop_percent
 *   - #36: tax_annual placeholder cleanup + tax_is_estimated / tax_status
 *   - #41: portal_url_hyperlink (Google-Sheets =HYPERLINK(...) formula)
 *   - #42: address_alternates[] (MLS-feed mismatch surfacing)
 *   - #50: last_sold_date + last_sold_price (from price-history)
 */

/**
 * Convert an HOA `{amount, frequency}` to monthly USD, rounded to the
 * nearest dollar. Returns `null` for unknown frequency strings (with a
 * stderr warning) or when the inputs are absent.
 *
 * Frequencies modelled match Redfin's MLS-feed vocabulary
 * (`Annually` / `Quarterly` / `Monthly` / `SemiAnnually` / `Weekly`).
 */
export function hoaToMonthlyUsd(
  amount: number | undefined | null,
  frequency: string | undefined | null
): number | null {
  if (typeof amount !== 'number' || !frequency) return null;
  let monthly: number;
  switch (frequency) {
    case 'Monthly':
      monthly = amount;
      break;
    case 'Annually':
      monthly = amount / 12;
      break;
    case 'Quarterly':
      monthly = amount / 3;
      break;
    case 'SemiAnnually':
      monthly = amount / 6;
      break;
    case 'Weekly':
      monthly = (amount * 52) / 12;
      break;
    default:
      console.error(
        `[redfin-mcp] hoa_monthly_usd: unknown HOA frequency "${frequency}" — returning null`
      );
      return null;
  }
  return Math.round(monthly);
}

/**
 * `{ price_drop_amount, price_drop_percent }` from a current+previous
 * list price. Returns `{null, null}` whenever either is missing.
 * Percent rounded to 0.1.
 */
export function priceDrop(
  currentPrice: number | undefined | null,
  previousPrice: number | undefined | null
): { price_drop_amount: number | null; price_drop_percent: number | null } {
  if (
    typeof currentPrice !== 'number' ||
    typeof previousPrice !== 'number' ||
    previousPrice === 0
  ) {
    return { price_drop_amount: null, price_drop_percent: null };
  }
  const amount = previousPrice - currentPrice;
  const percent = Math.round((amount / previousPrice) * 1000) / 10;
  return { price_drop_amount: amount, price_drop_percent: percent };
}

/**
 * Sentinel cleanup for tax_annual. Redfin returns `0` or `1` for
 * not-yet-assessed new-construction parcels — those values silently
 * corrupt downstream affordability/cost-of-ownership math when treated
 * as real bills.
 *
 * `tax_status: "not_yet_assessed"` is emitted only when the value is
 * the 0/1 placeholder; "estimated" / "actual" require an upstream
 * marker that Redfin doesn't currently expose, so they're left
 * unset until verified live.
 */
export function cleanTaxAnnual(
  raw: number | undefined | null
): { tax_annual: number | null; tax_status: 'not_yet_assessed' | null } {
  if (typeof raw !== 'number') return { tax_annual: null, tax_status: null };
  if (raw === 0 || raw === 1) {
    return { tax_annual: null, tax_status: 'not_yet_assessed' };
  }
  return { tax_annual: raw, tax_status: null };
}

/**
 * Google-Sheets `HYPERLINK` formula pointing at the canonical Redfin
 * URL. Pasting the value into a Sheets cell renders as a clickable
 * "Redfin" link.
 */
export function buildPortalUrlHyperlink(canonicalUrl: string): string {
  // Escape any literal double-quote in the URL for the Sheets formula.
  const safe = canonicalUrl.replace(/"/g, '""');
  return `=HYPERLINK("${safe}","Redfin")`;
}

/**
 * Normalize an address for equality checks — collapse whitespace, drop
 * common punctuation, lowercase. Used to dedupe `address_alternates`
 * against the primary address.
 */
function normalizeAddressForCompare(s: string | undefined | null): string {
  if (!s) return '';
  return s.toLowerCase().replace(/[,#.]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Collect alternate address strings from the raw payload, excluding any
 * that match the primary. Returns an empty array when nothing
 * surfaces. Candidates today: arbitrary MLS-feed-supplied strings the
 * caller passes via the `candidates` argument.
 */
export function collectAddressAlternates(
  primary: string | undefined | null,
  candidates: Array<string | undefined | null>
): string[] {
  const primaryNorm = normalizeAddressForCompare(primary);
  const seen = new Set<string>();
  const alternates: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const norm = normalizeAddressForCompare(candidate);
    if (!norm || norm === primaryNorm || seen.has(norm)) continue;
    seen.add(norm);
    alternates.push(candidate);
  }
  return alternates;
}

/**
 * Extract the most recent Sold event from a Redfin price-history event
 * list. Returns `{null, null}` when no Sold event is present.
 *
 * Redfin's `eventDescription` includes things like "Listed", "Price
 * Changed", "Sold (Public Records)", "Sold (MLS)". A simple
 * case-insensitive substring check on "Sold" is the reliable signal.
 */
export function lastSold(
  events: Array<{
    eventDescription?: string;
    eventDate?: number;
    price?: number;
  }>
): { last_sold_date: string | null; last_sold_price: number | null } {
  const sold = events
    .filter((e) => /sold/i.test(e.eventDescription ?? ''))
    .filter((e) => typeof e.eventDate === 'number')
    .sort((a, b) => (b.eventDate ?? 0) - (a.eventDate ?? 0));
  const top = sold[0];
  if (!top) return { last_sold_date: null, last_sold_price: null };
  return {
    last_sold_date: new Date(top.eventDate ?? 0).toISOString().slice(0, 10),
    last_sold_price: typeof top.price === 'number' ? top.price : null,
  };
}

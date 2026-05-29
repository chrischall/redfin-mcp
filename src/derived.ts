/**
 * Derived/normalized fields that lift per-listing math the caller was
 * otherwise redoing dozens of times per session. Centralized here so
 * properties / compare / search / history all use the same formulas.
 *
 * As of the realty-core migration (realty-mcp#1) the pure helpers that
 * were byte-identical across the cohort now live in
 * `@chrischall/realty-core` and are imported below. This file keeps only
 * the THIN redfin-specific adapters where the canonical signature/shape
 * differs from what redfin's tools call:
 *
 *   - `lotSizeAcres`      → re-export of `sqftToAcres` (identical math)
 *   - `hoaToMonthlyUsd`   → re-export (canonical is a superset)
 *   - `cleanTaxAnnual`    → re-export (CANONICAL DELTA: <10 sentinel)
 *   - `collectAddressAlternates` / `normalizeAddressForCompare`
 *                         → re-export (byte-identical)
 *   - `priceDrop`         → wrapper: canonical takes (previous, current)
 *                           and returns `{amount,percent}|null`; redfin's
 *                           call sites + field names want
 *                           `(current, previous) → {price_drop_amount,
 *                           price_drop_percent}`.
 *   - `buildPortalUrlHyperlink` → wrapper over `buildHyperlinkFormula`
 *                           with redfin's fixed `"Redfin"` label.
 *   - `lastSold`          → wrapper over the generic accessor-based
 *                           canonical helper, echoing back redfin's ISO
 *                           `last_sold_date` shape.
 *
 * Issues covered (original): #34 hoa_monthly_usd, #35 price_drop_*,
 * #36 tax cleanup, #41 portal_url_hyperlink, #42 address_alternates,
 * #50 last_sold_*, #82 lot_size_acres.
 */
import {
  priceDrop as priceDropCore,
  buildHyperlinkFormula,
  lastSold as lastSoldCore,
} from '@chrischall/realty-core';

// Byte-identical re-exports — these now live canonically in realty-core.
//
// `lotSizeAcres` is realty-core's `sqftToAcres` under redfin's name:
// same `round(sqft / 43560, 2)` math and the same `<= 0 → null` guard,
// so it's a drop-in for every value redfin passes (the property
// formatter already pre-nulls a 0/absent lotSqFt). Kept under the local
// name so call sites read as `lot_size_acres`.
export { sqftToAcres as lotSizeAcres } from '@chrischall/realty-core';
export { hoaToMonthlyUsd } from '@chrischall/realty-core';
// CANONICAL DELTA (#36): the not-yet-assessed sentinel threshold widened
// from redfin's `=== 0 || === 1` to realty-core's `< 10` (calibrated by
// homes-mcp against real new-build listings returning tax_annual 2–9).
// Values 2–9 are now treated as `not_yet_assessed` rather than real
// bills. See tests/derived.test.ts for the updated assertions.
export { cleanTaxAnnual } from '@chrischall/realty-core';
export {
  collectAddressAlternates,
  normalizeAddressForCompare,
} from '@chrischall/realty-core';

/**
 * `{ price_drop_amount, price_drop_percent }` from a current+previous
 * list price. Returns `{null, null}` whenever there's no real drop.
 *
 * Thin adapter over realty-core's `priceDrop`, which takes args in
 * `(previous, current)` order and returns either `{ amount, percent }`
 * (on a real drop) or `null` (no drop / bad inputs). Redfin's tools and
 * output fields use the `(current, previous)` order and the verbose
 * `price_drop_*` key names, so we reshape here. Behavior is identical to
 * the old inline version for redfin's inputs (a non-drop — current >=
 * previous — yields `{null, null}` either way).
 */
export function priceDrop(
  currentPrice: number | undefined | null,
  previousPrice: number | undefined | null
): { price_drop_amount: number | null; price_drop_percent: number | null } {
  const drop = priceDropCore(previousPrice ?? undefined, currentPrice ?? undefined);
  if (!drop) return { price_drop_amount: null, price_drop_percent: null };
  return { price_drop_amount: drop.amount, price_drop_percent: drop.percent };
}

/**
 * Google-Sheets `HYPERLINK` formula pointing at the canonical Redfin
 * URL with a fixed `"Redfin"` label. Pasting the value into a Sheets
 * cell renders as a clickable "Redfin" link.
 *
 * Thin adapter over realty-core's `buildHyperlinkFormula(url, label)`
 * (which escapes embedded `"` in both the url and the label — redfin
 * already did this for the url, so no behavior change).
 */
export function buildPortalUrlHyperlink(canonicalUrl: string): string {
  return buildHyperlinkFormula(canonicalUrl, 'Redfin');
}

/**
 * Extract the most recent Sold event from a Redfin price-history event
 * list. Returns `{null, null}` when no Sold event is present.
 *
 * Thin adapter over realty-core's generic `lastSold(events, accessors)`:
 * we supply redfin's `{ eventDescription, eventDate (epoch ms), price }`
 * accessors and convert the echoed-back epoch date to redfin's ISO
 * `YYYY-MM-DD` `last_sold_date` shape. Sold-event detection now goes
 * through realty-core's `mapEventType` (so "Sold (Public Records)" /
 * "Sold (MLS)" / "Closed" all count, while "Foreclosed" no longer
 * false-matches) rather than a raw `/sold/i` substring test.
 */
export function lastSold(
  events: Array<{
    eventDescription?: string;
    eventDate?: number;
    price?: number;
  }>
): { last_sold_date: string | null; last_sold_price: number | null } {
  const top = lastSoldCore(events, {
    date: (e) => e.eventDate,
    price: (e) => e.price,
    type: (e) => e.eventDescription,
  });
  if (!top || typeof top.date !== 'number') {
    return { last_sold_date: null, last_sold_price: null };
  }
  return {
    last_sold_date: new Date(top.date).toISOString().slice(0, 10),
    last_sold_price: top.price,
  };
}

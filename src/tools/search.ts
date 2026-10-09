import { z } from 'zod';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import type { RedfinClient } from '../client.js';
import { minifiedResult, unwrapValue as v } from '../mcp.js';
import { resolveBoth, type RedfinAddress } from '../autocomplete.js';
import { buildPortalUrlHyperlink, priceDrop } from '../derived.js';
import { extractZipFromLocation, homesMatchZipState } from '../geo.js';

/**
 * Redfin's search API: `GET /stingray/api/gis?...&region_id=X&region_type=Y`
 *
 * Steps:
 *   1. Resolve the user's free-text location to a region (region_id +
 *      region_type) via `location-autocomplete`.
 *   2. Call the gis endpoint with the region + filter params. Filters
 *      ride as query-string ints/CSVs (Redfin's web app does the same).
 *   3. Strip the `{}&&` prefix (RedfinClient.fetchStingrayJson handles
 *      this), then format `payload.homes[]` into a stable shape.
 *
 * Status codes (the `status` query param):
 *   1 = active for sale (the default)
 *   9 = active + coming-soon + contingent + pending (Redfin's default
 *       "everything for sale" view; gives more results than 1 alone)
 *
 * Verified live 2026-05-23 against region 30749 (New York City).
 */

type HomeType =
  | 'house'
  | 'condo'
  | 'townhouse'
  | 'multi_family'
  | 'manufactured'
  | 'land';

/**
 * Redfin's `uipt` (UI Property Type) codes — also echoed back per home as
 * `uiPropertyType`. Full scheme: 1 house, 2 condo, 3 townhouse,
 * 4 multi-family, 5 land, 6 other, 7 manufactured, 8 co-op (the default
 * `uipt=1,…,8` is "all"). `manufactured` was mapped to 6 ("Other") until
 * fleet-audit #670.
 */
const HOME_TYPE_UIPT: Record<HomeType, number> = {
  house: 1,
  condo: 2,
  townhouse: 3,
  multi_family: 4,
  land: 5,
  manufactured: 7,
};

type StatusKey = 'for_sale' | 'for_rent' | 'sold';

/**
 * Only `for_sale` has a gis status code. Rentals and recently-sold live
 * on entirely different Redfin endpoints (`/apartments-for-rent/...`,
 * `/recently-sold`) that this tool does not call. `for_rent`/`sold` are
 * kept in the input enum only so they can be refused with a pointed
 * error (see {@link assertSupportedStatus}) — they used to map to 9 and
 * silently return active for-sale listings (fleet-audit #218).
 */
const FOR_SALE_STATUS_CODE = 9;

/** Redfin's gis API returns at most ~350 homes per call (#45). */
export const REDFIN_GIS_HARD_CAP = 350;

const DEFAULT_SEARCH_LIMIT = 40;

/** The `num_homes` actually requested from gis: the caller's limit
 * (default 40), clamped to the server's hard cap. */
export function effectiveGisLimit(limit: number | undefined): number {
  return Math.min(limit ?? DEFAULT_SEARCH_LIMIT, REDFIN_GIS_HARD_CAP);
}

/** Refuse statuses the gis search can't serve rather than silently
 * answering with for-sale listings (fleet-audit #218). */
export function assertSupportedStatus(status: StatusKey | undefined): void {
  if (status === undefined || status === 'for_sale') return;
  const hint =
    status === 'sold'
      ? 'Redfin serves recently-sold homes from a separate endpoint this tool does not call. For a property\'s own last sale use `redfin_get_property` (last_sold_price / last_sold_date) or `redfin_get_price_history`; for area sold-price trends use `redfin_get_market_report`.'
      : 'Redfin serves rentals from a separate endpoint this tool does not call. Use `redfin_get_comparable_rentals` for rental comps near a property.';
  throw new Error(
    `redfin_search_properties: status "${status}" is not supported — only "for_sale" is. ${hint}`
  );
}

export interface RawHome {
  propertyId?: number;
  listingId?: number;
  mlsId?: { value?: string };
  mlsStatus?: string;
  url?: string;
  streetLine?: { value?: string } | string;
  unitNumber?: { value?: string };
  city?: string;
  state?: string;
  zip?: string;
  price?: number | { value?: number };
  /** Redfin's gis API surfaces the prior list price as `previousPrice`
   * (or `originalPrice` on some payload variants). Either is good for
   * the price-drop derived fields (#35). */
  previousPrice?: number | { value?: number };
  originalPrice?: number | { value?: number };
  beds?: number;
  baths?: number;
  sqFt?: number | { value?: number };
  pricePerSqFt?: number | { value?: number };
  lotSize?: number | { value?: number };
  yearBuilt?: number | { value?: number };
  hoa?: number | { value?: number };
  latLong?: { value?: { latitude?: number; longitude?: number } };
  propertyType?: number;
  uiPropertyType?: number;
  searchStatus?: number;
  timeOnRedfin?: number;
  dom?: { value?: number };
}

export interface FormattedHome {
  property_id: number;
  listing_id?: number;
  mls_id?: string;
  status?: string;
  url: string;
  /** Sheets-paste-ready `=HYPERLINK(url,"Redfin")`. Always present. (#41) */
  portal_url_hyperlink: string;
  address: string;
  street?: string;
  unit?: string;
  city?: string;
  state?: string;
  zip?: string;
  price?: number;
  previous_list_price?: number;
  /** `previous_list_price - price`. `null` when either is missing. (#35) */
  price_drop_amount?: number | null;
  /** `(previous - current) / previous * 100`, rounded to 0.1. (#35) */
  price_drop_percent?: number | null;
  price_per_sqft?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  lot_size?: number;
  year_built?: number;
  hoa_monthly?: number;
  latitude?: number;
  longitude?: number;
  property_type?: number;
  days_on_redfin?: number;
}

export function formatHome(raw: RawHome): FormattedHome | null {
  if (!raw.propertyId) return null;
  const street = v(raw.streetLine);
  const unit = v(raw.unitNumber);
  const fullUrl = raw.url
    ? raw.url.startsWith('http')
      ? raw.url
      : `https://www.redfin.com${raw.url}`
    : `https://www.redfin.com/home/${raw.propertyId}`;
  const streetWithUnit =
    street && unit && street.endsWith(unit) ? street : [street, unit].filter(Boolean).join(' ').trim();
  const address = [
    streetWithUnit,
    raw.city,
    raw.state,
    raw.zip,
  ]
    .filter(Boolean)
    .join(', ');
  const currentPrice = v(raw.price);
  const previousListPrice = v(raw.previousPrice) ?? v(raw.originalPrice);
  const drop = priceDrop(currentPrice, previousListPrice);
  return {
    property_id: raw.propertyId,
    listing_id: raw.listingId,
    mls_id: v(raw.mlsId as { value?: string }),
    status: raw.mlsStatus,
    url: fullUrl,
    portal_url_hyperlink: buildPortalUrlHyperlink(fullUrl),
    address,
    street,
    unit,
    city: raw.city,
    state: raw.state,
    zip: raw.zip,
    price: currentPrice,
    ...(typeof previousListPrice === 'number'
      ? { previous_list_price: previousListPrice }
      : {}),
    price_drop_amount: drop.price_drop_amount,
    price_drop_percent: drop.price_drop_percent,
    price_per_sqft: v(raw.pricePerSqFt),
    beds: raw.beds,
    baths: raw.baths,
    sqft: v(raw.sqFt),
    lot_size: v(raw.lotSize),
    year_built: v(raw.yearBuilt),
    hoa_monthly: v(raw.hoa),
    latitude: raw.latLong?.value?.latitude,
    longitude: raw.latLong?.value?.longitude,
    property_type: raw.uiPropertyType ?? raw.propertyType,
    days_on_redfin: v(raw.dom),
  };
}

/** True when the caller passed any filter beyond the location. */
export function hasFilters(input: SearchInput): boolean {
  return (
    input.price_min !== undefined ||
    input.price_max !== undefined ||
    input.beds_min !== undefined ||
    input.baths_min !== undefined ||
    (input.home_types !== undefined && input.home_types.length > 0)
  );
}

/**
 * Re-apply the caller's filters to a formatted home. Redfin's gis API has
 * been seen ignoring min/max price, beds and uipt entirely (Oct 2026), so
 * the query params alone can't be trusted. A field Redfin left blank is
 * not grounds to drop the home.
 */
export function matchesFilters(h: FormattedHome, input: SearchInput): boolean {
  if (input.price_min !== undefined && h.price !== undefined && h.price < input.price_min) return false;
  if (input.price_max !== undefined && h.price !== undefined && h.price > input.price_max) return false;
  if (input.beds_min !== undefined && h.beds !== undefined && h.beds < input.beds_min) return false;
  if (input.baths_min !== undefined && h.baths !== undefined && h.baths < input.baths_min) return false;
  if (input.home_types && input.home_types.length > 0 && h.property_type !== undefined) {
    if (!input.home_types.some((t) => HOME_TYPE_UIPT[t] === h.property_type)) return false;
  }
  return true;
}

export interface SearchInput {
  location: string;
  status?: StatusKey;
  price_min?: number;
  price_max?: number;
  beds_min?: number;
  baths_min?: number;
  home_types?: HomeType[];
  limit?: number;
  bounds?: Bounds;
}

/**
 * Tokenize a label into lowercase alpha words for fuzzy matching.
 * "North Brooklyn" → ["north", "brooklyn"]. "arbor-heights" → ["arbor", "heights"].
 */
function tokens(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Two-letter US state codes we strip from the noise-token set; they
// appear inside thousands of unrelated addresses and would turn any
// silent fallback into a false-positive match.
const NOISE_TOKENS = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id',
  'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms',
  'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok',
  'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv',
  'wi', 'wy', 'dc', 'pr', 'usa', 'us',
]);

function discriminatingTokens(s: string | undefined): Set<string> {
  const out = new Set(tokens(s));
  for (const n of NOISE_TOKENS) out.delete(n);
  return out;
}

/** gis `region_type` of a ZIP-code region (see GIS_REGION_TYPE in autocomplete.ts). */
const ZIP_REGION_TYPE = 2;

/**
 * Throw if the gis call's response doesn't actually describe the
 * requested region. Three failure modes surface here:
 *
 *   1. `serviceRegionName` is set but unrelated (e.g. you asked for
 *      "Brooklyn" type-6, gis returned "arbor-heights"). This is the
 *      original silent-fallback bug from v0.4.1.
 *   2. `serviceRegionName` is absent but the returned `homes[]` are
 *      in a different city/state than the resolved region (e.g.
 *      Asheville, NC type-2 returns gis homes in Ipswich, MA). Newer
 *      gis behavior — same underlying fallback, just no diagnostic
 *      field. Verified live 2026-05-24 against Asheville (2_555).
 *   3. The location was a ZIP and the returned homes' states are
 *      inconsistent with the ZIP's first-digit prefix (e.g. ZIP 28746
 *      → North Carolina; got Washington homes). Catches the canonical
 *      cross-continent fallback (#46). The ZIP check fires BEFORE
 *      path 2 because state-level mismatches are the most dangerous
 *      class — silently mixing in other-state listings corrupts
 *      downstream analysis.
 *
 * Zero results are accepted as legitimate (small markets with no
 * Redfin MLS coverage will get an empty result with a notice from the
 * caller).
 */
export function assertRegionMatches(
  region: { name: string; sub_name?: string; region_type: number; region_id: number },
  payload: {
    serviceRegionName?: string;
    homes?: Array<{ city?: string; state?: string; zip?: string }>;
  },
  inputLocation?: string
): void {
  // Path 3 (run FIRST): ZIP → expected states sanity check. Fires only
  // when the caller's location string contains a recognizable US ZIP
  // and the result set has any homes to check. Stops cross-continent
  // fallbacks (canonical case: ZIP 28746 returning Seattle results) (#46).
  const zip = extractZipFromLocation(inputLocation);
  if (zip) {
    const homes = payload.homes ?? [];
    const zipCheck = homesMatchZipState(
      zip,
      homes.map((h) => h.state)
    );
    if (zipCheck.matched === false && zipCheck.plausibleStates) {
      const plausible = Array.from(zipCheck.plausibleStates).sort().join(', ');
      const firstState = homes[0]?.state ?? '?';
      const firstCity = homes[0]?.city ?? 'an unknown city';
      throw new Error(
        `redfin_search_properties: ZIP ${zip} not in Redfin's coverage — ` +
          `the gis API returned ${homes.length} result(s) in ${firstCity}, ${firstState}, ` +
          `but ZIP ${zip} belongs to ${plausible}. ` +
          `This is Redfin's cross-continent silent fallback — try the city name instead ` +
          `(e.g. "Lake Lure, NC" rather than "${zip}"), or use \`redfin_get_by_address\` ` +
          `for per-property lookup.`
      );
    }
  }

  // Path 0: ZIP regions are judged by the homes' own ZIPs. Inside big
  // cities gis reports a neighborhood-style serviceRegionName (e.g.
  // "berryessa-alum-rock" for 95133) that never shares a token with the
  // ZIP's name, so the name checks below would reject a correct answer.
  // Only for a ZIP *region*: "San Jose, CA 95133" can resolve to the city,
  // whose homes legitimately span many ZIPs.
  if (zip && region.region_type === ZIP_REGION_TYPE) {
    const withZip = (payload.homes ?? []).filter((h) => h.zip);
    if (withZip.length > 0) {
      const inZip = withZip.filter((h) => h.zip === zip).length;
      if (inZip / withZip.length >= 0.8) return;
      throw new Error(
        `redfin_search_properties: Redfin's gis API fell back for ZIP ${zip} — only ${inZip} of ` +
          `${withZip.length} returned homes are in that ZIP. Try the parent city, or a bounds search.`
      );
    }
  }

  const wanted = new Set([
    ...discriminatingTokens(region.name),
    ...discriminatingTokens(region.sub_name),
  ]);
  if (wanted.size === 0) return; // nothing discriminating to check

  // Path 1: serviceRegionName provided — slug-style match against wanted.
  if (payload.serviceRegionName) {
    const got = discriminatingTokens(payload.serviceRegionName);
    for (const w of wanted) if (got.has(w)) return;
    throw new Error(
      `redfin_search_properties: Redfin's gis API doesn't fully support this region — ` +
        `requested "${region.name}" (${region.region_type}_${region.region_id}) but the server ` +
        `returned results for "${payload.serviceRegionName}". This commonly happens with neighborhood-typed ` +
        `regions in big cities. Try a parent city (e.g. "New York" instead of "Brooklyn"), or pass ` +
        `region_id + region_type directly for a known-working pair.`
    );
  }

  // Path 2: serviceRegionName absent — check the actual homes' cities.
  const homes = payload.homes ?? [];
  if (homes.length === 0) return; // 0 results is a legit signal; caller surfaces it.
  for (const h of homes) {
    const got = new Set([
      ...discriminatingTokens(h.city),
      ...discriminatingTokens(h.state),
    ]);
    for (const w of wanted) if (got.has(w)) return;
  }
  const firstCity = homes[0]?.city ?? 'an unknown city';
  const firstState = homes[0]?.state ?? '?';
  throw new Error(
    `redfin_search_properties: Redfin's gis API silently fell back — ` +
      `requested "${region.name}" (${region.region_type}_${region.region_id}) but all ${homes.length} ` +
      `returned result(s) are in ${firstCity}, ${firstState} (or similar) — none match the requested region. ` +
      `This happens with smaller markets outside Redfin's MLS coverage. Try a nearby larger city or county, ` +
      `or pass region_id + region_type directly for a known-working pair.`
  );
}

export interface Bounds { north: number; south: number; east: number; west: number }

/** Redfin's drawn-map polygon param: "lng lat,lng lat,..." closed ring. */
export function boundsToPoly(b: Bounds): string {
  const pts = [
    [b.west, b.south],
    [b.east, b.south],
    [b.east, b.north],
    [b.west, b.north],
    [b.west, b.south],
  ];
  return pts.map(([lng, lat]) => `${lng.toFixed(6)} ${lat.toFixed(6)}`).join(',');
}

/** True when a home with coordinates lies outside the box (small tolerance). */
export function homeOutside(h: FormattedHome, b: Bounds, tol = 0.002): boolean {
  if (h.latitude === undefined || h.longitude === undefined) return false;
  return h.latitude > b.north + tol || h.latitude < b.south - tol || h.longitude > b.east + tol || h.longitude < b.west - tol;
}

export function quarterBounds(b: Bounds): Bounds[] {
  const mLat = (b.north + b.south) / 2;
  const mLng = (b.east + b.west) / 2;
  return [
    { north: b.north, south: mLat, west: b.west, east: mLng },
    { north: b.north, south: mLat, west: mLng, east: b.east },
    { north: mLat, south: b.south, west: b.west, east: mLng },
    { north: mLat, south: b.south, west: mLng, east: b.east },
  ];
}

/**
 * Request shapes for a drawn-map search. Redfin's map uses `user_poly`
 * ("lng lat,lng lat,..."); an unknown param (e.g. `poly`) is silently ignored
 * and gis falls back to the browser session's last search region. Because the
 * endpoint is undocumented, callers probe these in order and keep the first
 * whose homes actually fall inside the box.
 */
export const POLY_VARIANTS = ['user_poly', 'user_poly_region', 'viewport', 'viewport_region', 'user_poly_al3', 'poly'] as const;
export type PolyVariant = (typeof POLY_VARIANTS)[number];

/** gis path for a drawn-map (polygon) search. */
export function buildGisPolyPath(
  bounds: Bounds,
  input: SearchInput,
  variant: PolyVariant = 'user_poly',
  region?: { region_id: number; region_type: number }
): string {
  const base = buildGisPath(region ?? { region_id: 0, region_type: 0 }, { ...input, limit: REDFIN_GIS_HARD_CAP });
  const qs = new URLSearchParams(base.split('?')[1]);
  const withRegion = variant === 'user_poly_region' || variant === 'viewport_region';
  if (!withRegion || !region) {
    qs.delete('region_id');
    qs.delete('region_type');
  }
  if (variant === 'user_poly_al3') {
    qs.set('al', '3');
    qs.set('sp', 'true');
    qs.set('page_number', '1');
  }
  if (variant === 'viewport' || variant === 'viewport_region') {
    // Same order as Redfin's /filter/viewport=N:S:E:W page URLs.
    qs.set('viewport', `${bounds.north}:${bounds.south}:${bounds.east}:${bounds.west}`);
  } else {
    qs.set(variant === 'poly' ? 'poly' : 'user_poly', boundsToPoly(bounds));
  }
  return `/stingray/api/gis?${qs.toString()}`;
}

export interface PolyFetch {
  raw: RawHome[];
  formatted: FormattedHome[];
  outside: number;
  /** The request shape whose homes fell inside the box; null when none did. */
  variant: PolyVariant | null;
  tried: Array<{ variant: PolyVariant; raw: number; outside: number }>;
  /** True when `maxRequests` cut the probe short before every shape was tried. */
  truncated: boolean;
}

/** Homes are "area-limited" when at most 20% (min 2) fall outside the box. */
export function areaLimited(raw: number, outside: number): boolean {
  return raw === 0 || outside <= Math.max(2, raw * 0.2);
}

/**
 * Fetch one box. With `variant` set, uses only that shape; otherwise probes
 * POLY_VARIANTS (skipping the region one when no region is known) and keeps
 * the first area-limited answer. `maxRequests` caps how many shapes are tried.
 */
export async function fetchPolyHomes(
  client: RedfinClient,
  bounds: Bounds,
  input: SearchInput,
  opts: { variant?: PolyVariant; region?: { region_id: number; region_type: number }; maxRequests?: number } = {}
): Promise<PolyFetch> {
  const all = opts.variant
    ? [opts.variant]
    : POLY_VARIANTS.filter((v) => (v !== 'user_poly_region' && v !== 'viewport_region') || opts.region);
  const candidates = all.slice(0, Math.max(0, opts.maxRequests ?? all.length));
  const truncated = candidates.length < all.length;
  const tried: PolyFetch['tried'] = [];
  let last: Omit<PolyFetch, 'variant' | 'tried' | 'truncated'> = { raw: [], formatted: [], outside: 0 };
  for (const v of candidates) {
    const env = await client.fetchStingrayJson<{ homes?: RawHome[] }>(buildGisPolyPath(bounds, input, v, opts.region));
    const raw = env.payload?.homes ?? [];
    const formatted = raw.map(formatHome).filter((h): h is FormattedHome => h !== null);
    const outside = formatted.filter((h) => homeOutside(h, bounds)).length;
    tried.push({ variant: v, raw: raw.length, outside });
    last = { raw, formatted, outside };
    if (areaLimited(raw.length, outside)) return { ...last, variant: v, tried, truncated: false };
  }
  return { ...last, variant: null, tried, truncated };
}

/**
 * Build the gis endpoint path + params for a resolved region + filters.
 */
export function buildGisPath(
  region: { region_id: number; region_type: number },
  input: SearchInput
): string {
  const limit = effectiveGisLimit(input.limit);
  const uipt =
    input.home_types && input.home_types.length > 0
      ? input.home_types.map((t) => HOME_TYPE_UIPT[t]).join(',')
      : '1,2,3,4,5,6,7,8';
  const params: Record<string, string> = {
    al: '1',
    num_homes: String(limit),
    region_id: String(region.region_id),
    region_type: String(region.region_type),
    sf: '1,2,3,5,6,7',
    start: '0',
    status: String(FOR_SALE_STATUS_CODE),
    uipt,
    v: '8',
  };
  if (input.price_min !== undefined) params.min_price = String(input.price_min);
  if (input.price_max !== undefined) params.max_price = String(input.price_max);
  if (input.beds_min !== undefined) params.num_beds = String(input.beds_min);
  if (input.baths_min !== undefined) params.num_baths = String(input.baths_min);
  return `/stingray/api/gis?${new URLSearchParams(params).toString()}`;
}

/**
 * When autocomplete returns NO Places match but DID match an
 * Addresses row, the user clearly meant "find this specific home" —
 * not "search the region around it". Surface the resolved address as
 * a one-row result so the caller can pick up the home_id and follow
 * up with `redfin_get_property` if they want details. Skips the gis
 * call entirely.
 *
 * The shape mirrors a normal `redfin_search_properties` response so a
 * caller iterating `results[]` doesn't need a special-case branch;
 * `resolved_as: 'address'` is the discriminator if they do.
 */
export function addressOnlyResult(address: RedfinAddress): {
  region: null;
  resolved_as: 'address';
  notice: string;
  results: FormattedHome[];
} {
  const fullUrl = address.url;
  const result: FormattedHome = {
    property_id: parseInt(address.home_id, 10),
    url: fullUrl,
    portal_url_hyperlink: buildPortalUrlHyperlink(fullUrl),
    address: [address.street_address, address.city, address.state, address.zip]
      .filter(Boolean)
      .join(', '),
    street: address.street_address,
    city: address.city,
    state: address.state,
    zip: address.zip,
    price_drop_amount: null,
    price_drop_percent: null,
  };
  return {
    region: null,
    resolved_as: 'address',
    notice:
      "Redfin's autocomplete matched the input as a single address (not a region), so we skipped the gis search and returned the resolved home. " +
      'Call `redfin_get_property` with this URL for the full property record.',
    results: [result],
  };
}

export function registerSearchTools(
  server: McpServer,
  client: RedfinClient
): void {
  server.registerTool(
    'redfin_search_properties',
    {
      title: 'Search Redfin listings',
      description:
        "Search Redfin listings by location (city, ZIP, neighborhood, or full street address) and optional filters. Resolves the location via Redfin's autocomplete then queries the gis API; full street addresses short-circuit to the single matched home (no gis call). Returns matching properties with price, beds/baths, sqft, year built, address, and the Redfin home URL. `resolved_as` is `'region'` / `'address'`. `coverage` is `'full'` (gis indexed this region), `'profile_only'` (Redfin has profiles for individual addresses here but search isn't indexed — use redfin_get_by_address per property), or `'none'`. `result_cap_hit: true` signals the result page is full — gis returned as many rows as requested (`limit`, default 40, max 350) — so more listings likely exist; raise `limit` or narrow with price/beds filters. ZIP queries that fall into Redfin's cross-continent fallback (e.g. ZIP 28746 returning Seattle results) now error loudly. Only `for_sale` status is supported; `sold` / `for_rent` return an error (use redfin_get_comparable_rentals for rentals, redfin_get_market_report for sold-price trends). Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Search Redfin listings',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        location: z
          .string()
          .describe(
            'Free-text location: city, ZIP, neighborhood, or address (e.g. "Brooklyn, NY", "94110", "Park Slope")'
          ),
        status: z
          .enum(['for_sale', 'for_rent', 'sold'])
          .optional()
          .describe(
            'Listing status. Only for_sale is supported; sold and for_rent return an error rather than for-sale results.'
          ),
        price_min: z.number().int().nonnegative().optional(),
        price_max: z.number().int().nonnegative().optional(),
        beds_min: z.number().int().nonnegative().optional(),
        baths_min: z.number().int().nonnegative().optional(),
        home_types: z
          .array(
            z.enum([
              'house',
              'condo',
              'townhouse',
              'multi_family',
              'manufactured',
              'land',
            ])
          )
          .optional()
          .describe('Restrict to one or more property types.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Max listings to return (default 40; values above 350, the gis hard cap, are clamped to 350).'
          ),
        bounds: z
          .object({ north: z.number(), south: z.number(), east: z.number(), west: z.number() })
          .optional()
          .describe('Optional lat/lng box: search this drawn-map area instead of the resolved region (works inside big cities where ZIP/neighborhood regions fall back). `location` is then only a label.'),
      }),
    },
    async (input) => {
      // One autocomplete call returns both a Places (region) and an
      // Addresses match when either exists. Address-typed queries
      // (full street addresses) typically return Addresses-only —
      // before this change we'd error out, even though the user gave
      // us a perfectly resolvable address. Fix for #24.
      assertSupportedStatus(input.status);
      if (input.bounds) {
        // A resolvable location (e.g. the city) lets the probe also try the
        // region-pinned request shapes; a free-text label is fine too.
        const pin = await resolveBoth(client, input.location).then((r) => r.region ?? undefined).catch(() => undefined);
        const { raw, formatted, outside, variant, tried } = await fetchPolyHomes(client, input.bounds, input, { region: pin });
        const matching = formatted.filter((h) => matchesFilters(h, input));
        const limit = effectiveGisLimit(input.limit);
        const capped = raw.length >= REDFIN_GIS_HARD_CAP;
        return minifiedResult({
          resolved_as: 'bounds' as const,
          bounds: input.bounds,
          scanned: raw.length,
          matched: matching.length,
          outside_bounds: outside,
          result_cap_hit: capped || matching.length > limit,
          ...(capped ? { notice: `Redfin returned the ${REDFIN_GIS_HARD_CAP}-home cap for this box, so more homes exist — split the box (or use redfin_sweep_area).` } : {}),
          poly_variant: variant,
          ...(variant === null ? { drift_warning: 'Every polygon request shape returned homes outside the box — Redfin is ignoring the polygon; these results are not area-limited.', poly_probe: tried } : {}),
          results: matching.slice(0, limit),
        });
      }
      const { region, address } = await resolveBoth(client, input.location);
      if (!region) {
        if (address) {
          // coverage: "profile_only" — Redfin has the address-level
          // profile page but no gis/MLS coverage for the surrounding
          // region. Surfaced explicitly so callers know to keep using
          // per-address resolution rather than retrying with a broader
          // search. (#47)
          return minifiedResult({
            ...addressOnlyResult(address),
            coverage: 'profile_only' as const,
          });
        }
        throw new Error(
          `redfin_search_properties: could not resolve location "${input.location}" to a Redfin region or address. ` +
            `If you have a full street address, try \`redfin_get_by_address\` instead.`
        );
      }
      // With filters, pull the full page and filter here (see matchesFilters).
      const filtering = hasFilters(input);
      const gisLimit = filtering ? REDFIN_GIS_HARD_CAP : effectiveGisLimit(input.limit);
      const path = buildGisPath(region, { ...input, limit: gisLimit });
      const env = await client.fetchStingrayJson<{
        homes?: RawHome[];
        serviceRegionName?: string;
      }>(path);
      const raw = env.payload?.homes ?? [];
      // Detect Redfin's silent-fallback failure modes: gis ignores the
      // region and returns either (a) results for a different
      // serviceRegionName, (b) results whose city/state share no
      // discriminating tokens with the requested region, or (c) ZIP →
      // wrong-state results (the cross-continent fallback). #46.
      assertRegionMatches(
        region,
        {
          serviceRegionName: env.payload?.serviceRegionName,
          homes: raw.map((h) => ({ city: h.city, state: h.state, zip: h.zip })),
        },
        input.location
      );
      const limit = effectiveGisLimit(input.limit);
      const matching = raw
        .map(formatHome)
        .filter((h): h is FormattedHome => h !== null)
        .filter((h) => matchesFilters(h, input));
      const formatted = matching.slice(0, limit);

      // #45 silent-cap audit. Redfin's gis API returns at most
      // ~350 homes per call (verified live across high-density metros;
      // Redfin's web UI paginates beyond that). We don't paginate
      // server-side today — instead surface a `result_cap_hit` flag
      // and a hint so callers know when to narrow their query.
      // Cap-hit is a property of the raw gis payload, NOT of the
      // post-format / post-limit `formatted` slice. Two false-negative
      // paths the old `formatted.length === raw.length` check missed:
      // (a) formatHome drops rows lacking propertyId, so formatted can
      // be shorter than raw even when no client-side limit applied;
      // (b) when the caller passes a `limit` below the cap, `.slice`
      // truncates formatted independently. Either way, if raw hit the
      // cap, more listings exist server-side and we should signal it.
      //
      // gis is asked for `num_homes = limit` (default 40), so it can
      // never return more than that. A full page — raw.length reaching
      // the requested limit — therefore means more listings likely
      // exist, whether that limit is the caller's, the default, or the
      // 350 server cap (fleet-audit #217: the old `>= 350` check could
      // only fire when the caller asked for 350+).
      const serverCapHit = raw.length >= REDFIN_GIS_HARD_CAP;
      const resultCapHit = filtering
        ? serverCapHit || matching.length > limit
        : serverCapHit || raw.length >= limit;

      // #47 coverage. Map (gis returned homes) → 'full'; (gis empty
      // but Redfin clearly has individual profiles) → 'profile_only'
      // when an address match also resolved on the same query;
      // otherwise 'none'.
      // We can detect address-availability cheaply by checking whether
      // resolveBoth also returned an `address` value. Today's
      // implementation runs that lookup once at the top of this
      // handler.
      const coverage: 'full' | 'profile_only' | 'none' =
        raw.length > 0
          ? 'full'
          : address
            ? 'profile_only'
            : 'none';

      // Surface a helpful notice when gis legitimately has no listings
      // for a resolved-but-tiny market (e.g. Lake Lure, NC).
      const notice =
        filtering && raw.length > 0 && formatted.length === 0
          ? `None of the ${raw.length} homes Redfin returned for "${region.name}" match the filters.` +
            (serverCapHit ? ` Redfin capped the scan at ${REDFIN_GIS_HARD_CAP}, so matches may still exist — try a smaller area.` : '')
          : raw.length === 0
          ? `Redfin's gis API returned 0 results for region ${region.region_type}_${region.region_id} ("${region.name}"). ` +
            `coverage: ${coverage}. ` +
            (coverage === 'profile_only'
              ? "Redfin has per-property profile pages here but does not index this market in search — use `redfin_get_by_address` for individual properties."
              : "This often means the location is outside Redfin's MLS coverage rather than that there are genuinely no listings. Try a nearby larger city, the county, or compare against redfin.com directly.")
          : serverCapHit && filtering
            ? `Redfin returns at most ${REDFIN_GIS_HARD_CAP} homes per area and ignores the filters itself, so only those ${REDFIN_GIS_HARD_CAP} were filtered here (${matching.length} matched). Matching homes outside that set are missing — search smaller areas (ZIP codes or neighborhoods) to cover the rest.`
          : serverCapHit
            ? `Redfin's gis API returned the hard cap (~${REDFIN_GIS_HARD_CAP}) of results — more listings likely exist for this region. Narrow with price/beds filters, or query a smaller sub-region, to enumerate the long tail.`
            : resultCapHit && filtering
              ? `${matching.length} of ${raw.length} scanned homes match the filters; returning the first ${limit}. Raise \`limit\` to see the rest.`
            : resultCapHit
              ? `Returned ${raw.length} results — the requested limit of ${limit} — so more listings likely exist for this region. Raise \`limit\` (up to ${REDFIN_GIS_HARD_CAP}), or narrow with price/beds filters, to see the rest.`
              : undefined;
      return minifiedResult({
        resolved_as: 'region' as const,
        region: {
          name: region.name,
          sub_name: region.sub_name,
          region_id: region.region_id,
          region_type: region.region_type,
        },
        coverage,
        result_cap_hit: resultCapHit,
        ...(filtering ? { scanned: raw.length, matched: matching.length } : {}),
        ...(notice ? { notice } : {}),
        results: formatted,
      });
    }
  );

  server.registerTool(
    'redfin_sweep_area',
    {
      title: 'Exhaustively sweep a Redfin map area',
      description:
        "Enumerate EVERY for-sale Redfin listing inside a bounding box without silent truncation. Redfin's gis API returns at most 350 homes per call and ignores server-side filters, so this tool searches drawn-map polygons, recursively quarters any tile that hits the cap, dedupes by property_id and re-applies the caller's filters locally. Homes outside the box and tiles where Redfin drifted to another region are left out. Alternatively pass `zips` (ZIP mode) to sweep a list of ZIP regions instead of map tiles, when Redfin ignores drawn-map polygons. Returns a completeness summary (requests, tiles or ZIPs, unique listings, tiles/ZIPs still at the cap, drift warnings) plus the listings inline by default; pass the optional `output_path` to write them to a new JSON file instead, for large areas. Sequential requests with a delay. Read-only against Redfin; the only write is the optional local output file.",
      annotations: { title: 'Sweep Redfin area', readOnlyHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        bounds: z
          .object({ north: z.number(), south: z.number(), east: z.number(), west: z.number() })
          .optional()
          .describe('Box to sweep (lat/lng). Required unless `zips` is given.'),
        location: z.string().optional().describe('Optional city (e.g. "San Jose, CA") whose region lets the polygon probe try region-pinned request shapes.'),
        zips: z
          .array(z.string().regex(/^\d{5}$/))
          .max(80)
          .optional()
          .describe('ZIP mode: sweep these ZIP regions instead of map tiles (fallback when Redfin ignores drawn-map polygons). Each ZIP is checked by the homes\' own ZIPs; a ZIP that returns the 350-home cap is reported as capped.'),
        price_min: z.number().int().nonnegative().optional(),
        price_max: z.number().int().nonnegative().optional(),
        beds_min: z.number().int().nonnegative().optional(),
        baths_min: z.number().int().nonnegative().optional(),
        home_types: z.array(z.enum(['house', 'condo', 'townhouse', 'multi_family', 'manufactured', 'land'])).optional(),
        max_depth: z.number().int().min(0).max(8).optional().describe('Max quarterings per tile (default 6).'),
        delay_ms: z.number().int().min(0).max(10000).optional().describe('Pause between requests (default 1200).'),
        max_requests: z.number().int().positive().max(400).optional().describe('Hard request budget (default 120).'),
        output_path: z.string().optional().describe('Optional absolute path of a NEW JSON file to write the full results (and per-tile counts) to; a relative path or an existing file is refused rather than overwritten. Omit to get the results inline; use a file for large areas so the listings stay out of the conversation.'),
      }),
    },
    async (input) => minifiedResult(await sweepRedfinArea(client, input))
  );
}

export interface RedfinSweepInput {
  bounds?: Bounds;
  location?: string;
  zips?: string[];
  price_min?: number;
  price_max?: number;
  beds_min?: number;
  baths_min?: number;
  home_types?: HomeType[];
  max_depth?: number;
  delay_ms?: number;
  max_requests?: number;
  output_path?: string;
}

/**
 * Refuse an output_path that is relative or already exists, before any
 * request is sent — a relative path would land wherever the server's cwd
 * happens to be, and an existing file may be someone's earlier sweep.
 */
export function assertSweepOutputPath(path: string | undefined): void {
  if (path === undefined) return;
  if (!isAbsolute(path)) {
    throw new Error(`redfin_sweep_area: output_path must be an absolute path (got "${path}").`);
  }
  if (existsSync(path)) {
    throw new Error(`redfin_sweep_area: output_path "${path}" already exists — refusing to overwrite it. Pass a new file name, or delete the old file first.`);
  }
}

/** Write a sweep's full result set; 'wx' keeps a file created mid-sweep safe too. */
function writeSweepFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(data, null, 1), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`redfin_sweep_area: output_path "${path}" was created by something else during the sweep — refusing to overwrite it. Re-run with a new file name.`);
    }
    throw e;
  }
}

export async function sweepRedfinArea(client: RedfinClient, input: RedfinSweepInput) {
  assertSweepOutputPath(input.output_path);
  if (input.zips && input.zips.length > 0) return sweepRedfinZips(client, input);
  if (!input.bounds) throw new Error('redfin_sweep_area: pass `bounds` (map mode) or `zips` (ZIP mode).');
  const rootBounds = input.bounds;
  const pin = input.location
    ? await resolveBoth(client, input.location).then((r) => r.region ?? undefined).catch(() => undefined)
    : undefined;
  const maxDepth = input.max_depth ?? 6;
  const delay = input.delay_ms ?? 1200;
  const budget = input.max_requests ?? 120;
  const filt: SearchInput = { location: '', price_min: input.price_min, price_max: input.price_max, beds_min: input.beds_min, baths_min: input.baths_min, home_types: input.home_types };
  const byId = new Map<number, FormattedHome & { tile: string; mls_status?: string }>();
  const tiles: Array<{ id: string; bounds: Bounds; depth: number; raw: number; capped: boolean; split: boolean; matched: number; outside: number }> = [];
  const warnings = new Set<string>();
  let requests = 0;
  let budgetHit = false;
  let variant: PolyVariant | undefined;
  let probe: PolyFetch['tried'] = [];
  let polyIgnored = false;
  let driftTiles = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const queue: Array<{ id: string; b: Bounds; depth: number }> = [{ id: 't', b: rootBounds, depth: 0 }];
  while (queue.length) {
    const t = queue.shift()!;
    if (requests >= budget) { budgetHit = true; tiles.push({ id: t.id, bounds: t.b, depth: t.depth, raw: -1, capped: true, split: false, matched: 0, outside: 0 }); continue; }
    if (delay && requests > 0) await sleep(delay);
    const f = await fetchPolyHomes(client, t.b, filt, { variant, region: pin, maxRequests: budget - requests });
    requests += f.tried.length;
    if (variant === undefined) {
      probe = f.tried;
      if (f.variant === null && f.truncated) {
        // The budget ran out mid-probe: no verdict on the polygon either way.
        budgetHit = true;
        tiles.push({ id: t.id, bounds: t.b, depth: t.depth, raw: f.raw.length, capped: true, split: false, matched: 0, outside: f.outside });
        break;
      }
      if (f.variant === null) {
        // No request shape is area-limited: tiling would only re-fetch the same
        // fallback region, so stop and report instead of returning a fake census.
        polyIgnored = true;
        warnings.add('Redfin ignored every polygon request shape (homes came back outside the box) — API drift; nothing was collected. See poly_probe.');
        tiles.push({ id: t.id, bounds: t.b, depth: t.depth, raw: f.raw.length, capped: true, split: false, matched: 0, outside: f.outside });
        break;
      }
      variant = f.variant;
    }
    const { raw, formatted, outside } = f;
    const capped = raw.length >= REDFIN_GIS_HARD_CAP;
    if (!areaLimited(raw.length, outside)) {
      // Drifted: these homes belong to Redfin's fallback region, not this tile,
      // so neither count them nor spend budget splitting the tile.
      driftTiles++;
      warnings.add('Some tiles came back mostly outside their box although the probe passed — Redfin drift mid-sweep; those tiles were skipped and count as incomplete.');
      tiles.push({ id: t.id, bounds: t.b, depth: t.depth, raw: raw.length, capped: false, split: false, matched: 0, outside });
      continue;
    }
    if (outside > 0) warnings.add('Some homes came back slightly outside their tile (boundary / geocode jitter); deduped by property_id, and homes outside the requested box dropped.');
    const needsSplit = capped && t.depth < maxDepth;
    const matching = formatted.filter((h) => matchesFilters(h, filt) && !homeOutside(h, rootBounds));
    tiles.push({ id: t.id, bounds: t.b, depth: t.depth, raw: raw.length, capped: capped && !needsSplit, split: needsSplit, matched: matching.length, outside });
    if (needsSplit) { quarterBounds(t.b).forEach((q, k) => queue.push({ id: `${t.id}${k}`, b: q, depth: t.depth + 1 })); continue; }
    for (const h of matching) {
      if (!byId.has(h.property_id)) {
        const r = raw.find((x) => x.propertyId === h.property_id);
        byId.set(h.property_id, { ...h, tile: t.id, mls_status: r?.mlsStatus });
      }
    }
  }
  const leaves = tiles.filter((t) => !t.split);
  const stillCapped = leaves.filter((t) => t.capped);
  const out = {
    source: 'redfin',
    swept_at: new Date().toISOString(),
    query: { ...input, output_path: undefined },
    requests,
    budget_hit: budgetHit,
    tiles,
    unique_listings: byId.size,
    raw_seen_leaf_sum: leaves.reduce((a, t) => a + Math.max(t.raw, 0), 0),
    poly_variant: variant ?? null,
    poly_probe: probe,
    complete: !budgetHit && !polyIgnored && driftTiles === 0 && stillCapped.length === 0,
    warnings: [...warnings],
    results: [...byId.values()],
  };
  if (input.output_path) writeSweepFile(input.output_path, out);
  return {
    ...(input.output_path ? { output_path: input.output_path } : {}),
    complete: out.complete,
    unique_listings: out.unique_listings,
    raw_seen_leaf_sum: out.raw_seen_leaf_sum,
    requests,
    leaf_tiles: leaves.length,
    split_tiles: tiles.length - leaves.length,
    capped_leaf_tiles: stillCapped.map((t) => ({ id: t.id, raw: t.raw, bounds: t.bounds })),
    poly_variant: out.poly_variant,
    ...(out.poly_variant === null ? { poly_probe: probe } : {}),
    drift_tiles: driftTiles,
    budget_hit: budgetHit,
    warnings: out.warnings,
    ...(input.output_path ? {} : { results: out.results }),
  };
}

/**
 * ZIP mode for redfin_sweep_area: one gis call per ZIP region, verified by
 * the homes' own ZIPs (assertRegionMatches path 0). A ZIP whose raw response
 * reaches the 350 cap cannot be split further here, so it is reported as
 * capped and the sweep is marked incomplete.
 */
export async function sweepRedfinZips(client: RedfinClient, input: RedfinSweepInput) {
  assertSweepOutputPath(input.output_path);
  const delay = input.delay_ms ?? 1200;
  const budget = input.max_requests ?? 120;
  const filt: SearchInput = { location: '', price_min: input.price_min, price_max: input.price_max, beds_min: input.beds_min, baths_min: input.baths_min, home_types: input.home_types };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const byId = new Map<number, FormattedHome & { zip_region: string; mls_status?: string }>();
  const zips: Array<{ zip: string; raw: number; matched: number; capped: boolean; error?: string }> = [];
  let requests = 0;
  let budgetHit = false;
  for (const zip of input.zips ?? []) {
    if (requests + 2 > budget) { budgetHit = true; zips.push({ zip, raw: -1, matched: 0, capped: false, error: 'request budget exhausted' }); continue; }
    if (delay && requests > 0) await sleep(delay);
    try {
      const { region } = await resolveBoth(client, zip);
      requests++;
      if (!region) { zips.push({ zip, raw: 0, matched: 0, capped: false, error: 'ZIP did not resolve to a Redfin region' }); continue; }
      const env = await client.fetchStingrayJson<{ homes?: RawHome[]; serviceRegionName?: string }>(buildGisPath(region, { ...filt, limit: REDFIN_GIS_HARD_CAP }));
      requests++;
      const raw = env.payload?.homes ?? [];
      assertRegionMatches(region, { serviceRegionName: env.payload?.serviceRegionName, homes: raw.map((h) => ({ city: h.city, state: h.state, zip: h.zip })) }, zip);
      const matching = raw.map(formatHome).filter((h): h is FormattedHome => h !== null).filter((h) => matchesFilters(h, filt));
      for (const h of matching) {
        if (!byId.has(h.property_id)) byId.set(h.property_id, { ...h, zip_region: zip, mls_status: raw.find((x) => x.propertyId === h.property_id)?.mlsStatus });
      }
      zips.push({ zip, raw: raw.length, matched: matching.length, capped: raw.length >= REDFIN_GIS_HARD_CAP });
    } catch (e) {
      zips.push({ zip, raw: -1, matched: 0, capped: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const capped = zips.filter((z) => z.capped).map((z) => z.zip);
  const failed = zips.filter((z) => z.error).map((z) => ({ zip: z.zip, error: z.error }));
  const out = {
    source: 'redfin',
    mode: 'zips' as const,
    swept_at: new Date().toISOString(),
    query: { ...input, output_path: undefined },
    requests,
    budget_hit: budgetHit,
    zips,
    unique_listings: byId.size,
    complete: !budgetHit && capped.length === 0 && failed.length === 0,
    warnings: [
      ...(capped.length ? [`ZIPs at the 350-home cap (more homes exist there): ${capped.join(', ')}`] : []),
      ...(failed.length ? [`ZIPs that failed or fell back: ${failed.map((f) => f.zip).join(', ')}`] : []),
    ],
    results: [...byId.values()],
  };
  if (input.output_path) writeSweepFile(input.output_path, out);
  return {
    ...(input.output_path ? { output_path: input.output_path } : {}),
    mode: 'zips' as const,
    complete: out.complete,
    unique_listings: out.unique_listings,
    requests,
    zips_swept: zips.length,
    capped_zips: capped,
    failed_zips: failed,
    budget_hit: budgetHit,
    warnings: out.warnings,
    ...(input.output_path ? {} : { results: out.results }),
  };
}

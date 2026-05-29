/**
 * Resolve a free-text location string to a Redfin region (region_id +
 * region_type) via the `/stingray/do/location-autocomplete` endpoint.
 *
 * Verified live (2026-05-23): autocomplete returns an envelope with
 * `payload.sections[]`, where each section has a `name` (`Places`,
 * `Addresses`, `Schools`, `Agents`, …) and a `rows[]`. Place rows carry
 * an `id` formatted as `"<type>_<region_id>"`. Address rows have no
 * `id` — they carry the canonical home URL in `url`, shaped like
 * `/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221`, from which we
 * extract the home_id and the address slug.
 *
 * `resolveRegion` returns the first Places row; `resolveAddress`
 * returns the first Addresses row. Address-typed queries (full street
 * addresses) typically return Addresses, not Places — Redfin's autocomplete
 * doesn't synthesize a region for every address.
 */
import type { RedfinClient } from './client.js';

export interface RedfinRegion {
  /** Numeric region id, e.g. 30749 for New York City. */
  region_id: number;
  /** Region type integer; 6 is common for both cities and neighborhoods. */
  region_type: number;
  /** Human-readable name (e.g. "Brooklyn"). */
  name: string;
  /** Subtitle context (e.g. "New York, NY, USA"). */
  sub_name?: string;
  /** Canonical Redfin URL path for the region (e.g. /city/30749/NY/New-York). */
  url: string;
}

export interface RedfinAddress {
  /** Numeric home id (a.k.a. property_id) as a string — Redfin URLs treat it as opaque. */
  home_id: string;
  /** Full Redfin URL for the home, e.g. https://www.redfin.com/NC/Lake-Lure/158-Raven-Blvd-28746/home/112653221. */
  url: string;
  /** Path-only form (no origin), suitable for `RedfinClient.fetchStingrayJson`. */
  path: string;
  /** Human-readable street address (e.g. "158 Raven Blvd"). */
  street_address: string;
  /** City as it appears in the URL (with spaces, e.g. "Lake Lure"). */
  city: string;
  /** Two-letter state code (e.g. "NC"). */
  state: string;
  /** ZIP code parsed from the URL slug. */
  zip: string;
}

interface AutocompleteRow {
  id?: string;
  name?: string;
  subName?: string;
  url?: string;
}

interface AutocompleteSection {
  name?: string;
  rows?: AutocompleteRow[];
}

interface AutocompletePayload {
  sections?: AutocompleteSection[];
}

/**
 * Parse the `id` field which Redfin formats as `"<type>_<region_id>"`.
 * Returns null on malformed input.
 */
export function parseRegionId(
  id: string | undefined
): { region_id: number; region_type: number } | null {
  if (!id) return null;
  const m = /^(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  return { region_type: parseInt(m[1], 10), region_id: parseInt(m[2], 10) };
}

/**
 * Parse a canonical Redfin home URL into its constituent parts.
 *
 * Canonical shape (verified 2026-05-26):
 *   /<ST>/<City-Slug>/<Street-Slug>-<ZIP>[/unit-<U>]/home/<home_id>
 *
 * Returns null when the URL doesn't fit this shape (e.g. a region URL
 * like `/city/30749/NY/New-York` or an arbitrary marketing page).
 */
export function parseAddressUrl(
  url: string | undefined
): {
  state: string;
  city: string;
  street: string;
  zip: string;
  home_id: string;
} | null {
  if (!url) return null;
  // Anchored: must start with /<ST>/<City>/<rest>/home/<id>. Optional
  // trailing slash is tolerated. The street-slug has a trailing -<ZIP>;
  // there can be a /unit-<X>/ segment between the slug and /home/.
  const m =
    /^\/([A-Z]{2})\/([^/]+)\/([^/]+?)-(\d{5})(?:\/unit-[^/]+)?\/home\/(\d+)\/?$/.exec(
      url
    );
  if (!m) return null;
  const [, state, citySlug, streetSlug, zip, homeId] = m;
  return {
    state,
    city: citySlug.replace(/-/g, ' '),
    street: streetSlug.replace(/-/g, ' '),
    zip,
    home_id: homeId,
  };
}

/** Build the location-autocomplete query string. */
function autocompletePath(query: string): string {
  const params = new URLSearchParams({
    location: query,
    start: '0',
    // Only `rows[0]` of each section is ever read (resolveRegion /
    // resolveAddress / resolveBoth all take the first row), so ask for a
    // single row rather than the default ten.
    count: '1',
    v: '2',
    iss: 'false',
    ooa: 'true',
    mrs: 'false',
  });
  return `/stingray/do/location-autocomplete?${params.toString()}`;
}

/**
 * Look up the first matching Places region for a free-text query.
 * Returns null if no Places result was found.
 */
export async function resolveRegion(
  client: RedfinClient,
  query: string
): Promise<RedfinRegion | null> {
  const env = await client.fetchStingrayJson<AutocompletePayload>(
    autocompletePath(query)
  );
  const sections = env.payload?.sections ?? [];
  const places = sections.find((s) => s.name === 'Places');
  const first = places?.rows?.[0];
  if (!first) return null;
  const parsed = parseRegionId(first.id);
  if (!parsed) return null;
  return {
    region_id: parsed.region_id,
    region_type: parsed.region_type,
    name: first.name ?? '',
    sub_name: first.subName,
    url: first.url ?? '',
  };
}

/**
 * Look up the first matching Addresses row for a free-text query.
 * Used for full street-address inputs that autocomplete maps to a
 * specific home (not a region). Returns null when no Addresses row is
 * present or when the URL doesn't parse into the canonical shape.
 */
export async function resolveAddress(
  client: RedfinClient,
  query: string
): Promise<RedfinAddress | null> {
  const env = await client.fetchStingrayJson<AutocompletePayload>(
    autocompletePath(query)
  );
  const sections = env.payload?.sections ?? [];
  const addresses = sections.find((s) => s.name === 'Addresses');
  const first = addresses?.rows?.[0];
  if (!first) return null;
  const parsed = parseAddressUrl(first.url);
  if (!parsed) return null;
  return {
    home_id: parsed.home_id,
    url: `https://www.redfin.com${first.url}`,
    path: first.url ?? '',
    street_address: first.name ?? parsed.street,
    city: parsed.city,
    state: parsed.state,
    zip: parsed.zip,
  };
}

/**
 * Single autocomplete call that surfaces BOTH a Places match (if any)
 * AND an Addresses match (if any). Used by `redfin_search_properties`
 * so it can fall back to the address path without spending a second
 * autocomplete round-trip.
 *
 * Both fields are independent — a ZIP query might return Places-only,
 * a full street address typically returns Addresses-only, and some
 * neighborhood queries return both.
 */
export async function resolveBoth(
  client: RedfinClient,
  query: string
): Promise<{ region: RedfinRegion | null; address: RedfinAddress | null }> {
  const env = await client.fetchStingrayJson<AutocompletePayload>(
    autocompletePath(query)
  );
  const sections = env.payload?.sections ?? [];

  let region: RedfinRegion | null = null;
  const placesRow = sections.find((s) => s.name === 'Places')?.rows?.[0];
  if (placesRow) {
    const parsed = parseRegionId(placesRow.id);
    if (parsed) {
      region = {
        region_id: parsed.region_id,
        region_type: parsed.region_type,
        name: placesRow.name ?? '',
        sub_name: placesRow.subName,
        url: placesRow.url ?? '',
      };
    }
  }

  let address: RedfinAddress | null = null;
  const addressRow = sections.find((s) => s.name === 'Addresses')?.rows?.[0];
  if (addressRow) {
    const parsed = parseAddressUrl(addressRow.url);
    if (parsed) {
      address = {
        home_id: parsed.home_id,
        url: `https://www.redfin.com${addressRow.url}`,
        path: addressRow.url ?? '',
        street_address: addressRow.name ?? parsed.street,
        city: parsed.city,
        state: parsed.state,
        zip: parsed.zip,
      };
    }
  }

  return { region, address };
}

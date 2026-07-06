// RedfinClient is the thin, tool-facing API over a RedfinTransport.
//
// Two fetch primitives:
//   - fetchHtml(path)          → raw HTML string (used for SSR pages
//                                where we regex-extract IDs, e.g. the
//                                favorites page)
//   - fetchStingrayJson(path)  → Redfin's `/stingray/...` API endpoints
//                                respond with a literal `{}&&` prefix
//                                before the JSON body (an anti-CSRF
//                                guard). This helper strips it and
//                                parses the rest.
//
// Error mapping (non-2xx, sign-in interstitial, empty 204 body) lives
// here so tool authors never have to think about it.
import {
  formatApiError,
  SessionNotAuthenticatedError,
} from '@chrischall/mcp-utils';
import type {
  BridgeProbeResult,
  BridgeStatus,
  FetchResult,
  RedfinTransport,
} from './transport.js';

// The canonical parameterized SessionNotAuthenticatedError lives in
// @chrischall/mcp-utils; re-exported so existing `./client.js`
// importers keep working. Thrown below as
// `new SessionNotAuthenticatedError('Redfin', 'redfin.com')` — the
// message names Redfin + the sign-in host and the instance carries a
// machine-readable `hint`.
export { SessionNotAuthenticatedError };

export interface RedfinClientOptions {
  /** Transport used to relay fetches to the user's browser. */
  transport: RedfinTransport;
}

/** Strip Redfin's `{}&&` anti-CSRF prefix from a stingray response body. */
export function stripStingrayPrefix(body: string): string {
  return body.startsWith('{}&&') ? body.slice(4) : body;
}

export class RedfinClient {
  private readonly transport: RedfinTransport;

  constructor(opts: RedfinClientOptions) {
    this.transport = opts.transport;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** Diagnostic snapshot of the bridge — surfaced by `redfin_healthcheck`. */
  bridgeStatus(): BridgeStatus {
    return this.transport.status();
  }

  /**
   * 0.10.0+: run one healthcheck probe through `fetchFn`, returning the
   * server's `BridgeProbeResult` (ok / elapsed_ms / classified error /
   * post-probe bridge projection). The probe-execution + timing +
   * classification + bridge snapshot now live in `@fetchproxy/server`;
   * `redfin_healthcheck` keeps only its Redfin-specific hint text.
   */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    return this.transport.runProbe(fetchFn, probePath);
  }

  /**
   * GET a redfin.com path, return the HTML body. Throws on non-2xx or
   * sign-in interstitial.
   */
  async fetchHtml(path: string): Promise<string> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignInPage(result);
    return result.body;
  }

  /**
   * Recover a property's canonical homedetails URL from its propertyId
   * alone (issue #89). Redfin's short `/home/<propertyId>` URL 301s to
   * the full `/<STATE>/<City>/<Street>-<ZIP>/home/<id>` slug; the bridge
   * fetch follows that redirect, so the response's final URL is the
   * canonical form we need. The Stingray `initialInfo` endpoint will not
   * resolve the bare `/home/<id>` path, so this redirect-follow is the
   * way to derive the slug server-side.
   *
   * Throws `SessionNotAuthenticatedError` if the hop lands on the sign-in
   * interstitial, or a hint-laden error if no redirect happened (the
   * propertyId is invalid/delisted and stayed on the bare `/home/<id>`
   * form).
   */
  async resolveCanonicalUrl(propertyId: number): Promise<string> {
    const path = `/home/${propertyId}`;
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignInPage(result);
    // A successful resolve redirects off the bare /home/<id> form onto the
    // /<STATE>/<City>/<Street>-<ZIP>/home/<id> slug. If the final URL is
    // still the short form, the id never resolved. Anchor to the start so
    // the canonical slug's trailing /home/<id> segment doesn't match.
    if (/^\/home\/\d+\/?$/.test(new URL(result.url).pathname)) {
      throw new Error(
        `Redfin property_id ${propertyId} could not be resolved from its id alone — ` +
          `the short /home/${propertyId} URL did not redirect to a canonical listing page. ` +
          `The id may be invalid or the listing delisted. Pass the full Redfin homedetails ` +
          `URL (with the /<STATE>/<City>/<Street>-<ZIP>/home/<id> slug) or property_id + listing_id instead.`
      );
    }
    return result.url;
  }

  /**
   * GET a `/stingray/...` JSON endpoint. Strips the `{}&&` anti-CSRF
   * prefix before parsing. Returns the full envelope, which Redfin
   * shapes as `{ version, errorMessage, resultCode, payload }`.
   */
  async fetchStingrayJson<T = unknown>(
    path: string
  ): Promise<StingrayEnvelope<T>> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignInPage(result);
    const stripped = stripStingrayPrefix(result.body);
    let parsed: StingrayEnvelope<T>;
    try {
      parsed = JSON.parse(stripped) as StingrayEnvelope<T>;
    } catch (e) {
      throw new Error(
        `Redfin GET ${path} — response (after stripping {}&& prefix) was not JSON: ${
          (e as Error).message
        }`
      );
    }
    if (parsed.resultCode !== 0) {
      throw new Error(
        `Redfin stingray error: resultCode=${parsed.resultCode} (${
          parsed.errorMessage ?? 'no errorMessage'
        }) for GET ${path}`
      );
    }
    return parsed;
  }

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    // `formatApiError` (from @chrischall/mcp-utils) redacts secrets
    // (Bearer tokens / JWTs) BEFORE truncating the upstream body, so a
    // Redfin error page that echoes a session token can't leak into a
    // tool result. Whitespace-collapse first to keep the old single-line
    // preview shape, then let formatApiError cap + redact it.
    const collapsed = result.body.replace(/\s+/g, ' ').trim();
    throw new Error(
      formatApiError(result.status, method, path, collapsed, {
        service: 'Redfin',
      })
    );
  }

  private throwIfSignInPage(result: FetchResult): void {
    // This guard checks TWO missing-session signals:
    //   1. Redirect to /login (URL match).
    //   2. AWS WAF challenge interstitial. Marker: the AWS WAF
    //      `awswaf.com/...challenge.js` script is referenced inline,
    //      with a small body (< 80KB) so a normal page that merely links
    //      to WAF assets doesn't false-positive.
    //
    // A THIRD signal — a stingray envelope with resultCode != 0 whose
    // errorMessage mentions login — is handled separately in
    // `fetchStingrayJson` (it inspects the parsed envelope, not the raw
    // result this method sees), so it is intentionally NOT checked here.
    //
    // We deliberately do NOT body-match `/login` since every signed-in
    // Redfin page has a "Sign in" link in its nav.
    const looksLikeSignIn =
      /\/login(\?|$)/.test(result.url) ||
      (result.body.includes('awswaf.com') &&
        result.body.includes('challenge.js') &&
        result.body.length < 80_000);
    if (looksLikeSignIn)
      throw new SessionNotAuthenticatedError('Redfin', 'redfin.com');
  }
}

/** Standard Redfin stingray response envelope. */
export interface StingrayEnvelope<T = unknown> {
  version?: number;
  errorMessage?: string;
  resultCode: number;
  payload?: T;
}

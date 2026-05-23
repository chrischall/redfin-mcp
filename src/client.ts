// RedfinClient is the thin, tool-facing API over a RedfinTransport.
//
// Three fetch primitives:
//   - fetchHtml(path)          → raw HTML string (used for SSR pages
//                                where we regex-extract IDs, e.g. the
//                                favorites page)
//   - fetchJson(path, init)    → standard JSON endpoint (currently
//                                unused but kept for forward compat)
//   - fetchStingrayJson(path)  → Redfin's `/stingray/...` API endpoints
//                                respond with a literal `{}&&` prefix
//                                before the JSON body (an anti-CSRF
//                                guard). This helper strips it and
//                                parses the rest.
//
// Error mapping (non-2xx, sign-in interstitial, empty 204 body) lives
// here so tool authors never have to think about it.
import type { FetchInit, FetchResult, RedfinTransport } from './transport.js';

export class SessionNotAuthenticatedError extends Error {
  constructor() {
    super(
      'Not signed in to Redfin. Open redfin.com in your browser and sign in, then try again. ' +
        'Saved searches, saved homes, and recent activity require a signed-in session.'
    );
    this.name = 'SessionNotAuthenticatedError';
  }
}

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
   * POST/PUT/DELETE a JSON body, return the parsed JSON. Throws on
   * non-2xx, invalid JSON, or sign-in page.
   */
  async fetchJson<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const method = init.method ?? 'POST';
    const serialised: FetchInit = {
      path,
      method,
      headers: {
        Accept: 'application/json',
        ...(method !== 'GET' && init.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(init.headers ?? {}),
      },
      body:
        method === 'GET' || init.body === undefined
          ? undefined
          : JSON.stringify(init.body),
    };
    const result = await this.transport.fetch(serialised);
    this.throwIfNotOk(result, method, path);
    this.throwIfSignInPage(result);
    if (result.status === 204 || result.body === '') {
      return null as T;
    }
    try {
      return JSON.parse(result.body) as T;
    } catch (e) {
      throw new Error(
        `Redfin ${method} ${path} — response was not JSON: ${String(
          (e as Error).message
        )}`
      );
    }
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
    const bodyPreview = result.body
      ? ` — ${result.body.slice(0, 500).replace(/\s+/g, ' ').trim()}${
          result.body.length > 500 ? '…' : ''
        }`
      : '';
    throw new Error(
      `Redfin API error: ${result.status} for ${method} ${path}${bodyPreview}`
    );
  }

  private throwIfSignInPage(result: FetchResult): void {
    // Redfin signals a missing session via:
    //   1. Redirect to /login (URL match).
    //   2. Stingray envelope with resultCode != 0 and an
    //      errorMessage mentioning login — caught in fetchStingrayJson.
    //   3. AWS WAF challenge interstitial. Marker: the AWS WAF
    //      `awswaf.com/...challenge.js` script is referenced inline.
    //
    // We deliberately do NOT body-match `/login` since every signed-in
    // Redfin page has a "Sign in" link in its nav.
    const looksLikeSignIn =
      /\/login(\?|$)/.test(result.url) ||
      (result.body.includes('awswaf.com') &&
        result.body.includes('challenge.js') &&
        result.body.length < 80_000);
    if (looksLikeSignIn) throw new SessionNotAuthenticatedError();
  }
}

/** Standard Redfin stingray response envelope. */
export interface StingrayEnvelope<T = unknown> {
  version?: number;
  errorMessage?: string;
  resultCode: number;
  payload?: T;
}

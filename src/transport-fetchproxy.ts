// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// redfin-mcp's RedfinTransport interface.
//
// FetchproxyServer is domain-agnostic — its FetchInit shape is
// `{ url, method, tabUrl, headers?, body? }`. redfin-mcp's tools and
// RedfinClient use redfin-relative paths (`/homedetails/...`,
// `/async-create-search-page-state/`), so the adapter prepends
// `https://www.redfin.com` and pins `tabUrl` to redfin.com so the
// extension routes the fetch through the right tab.
import { FetchproxyServer, type FetchproxyServerOpts } from '@fetchproxy/server';
import type { FetchInit, FetchResult, RedfinTransport } from './transport.js';

const REDFIN_ORIGIN = 'https://www.redfin.com';
const REDFIN_TAB_URL = 'https://www.redfin.com/';

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'redfin-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
}

export class FetchproxyTransport implements RedfinTransport {
  private readonly inner: FetchproxyServer;

  constructor(opts: FetchproxyTransportOptions) {
    const options: FetchproxyServerOpts = {
      port: opts.port ?? 37149,
      serverName: opts.server ?? 'redfin-mcp',
      version: opts.version,
      // Subdomains of redfin.com (www, photos, etc.) match automatically.
      domains: ['redfin.com'],
    };
    this.inner = new FetchproxyServer(options);
  }

  start(): Promise<void> {
    return this.inner.listen();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const url = init.path.startsWith('http')
      ? init.path
      : `${REDFIN_ORIGIN}${init.path}`;
    const result = await this.inner.fetch({
      url,
      method: init.method,
      tabUrl: REDFIN_TAB_URL,
      headers: init.headers,
      body: init.body,
    });
    // fetchproxy returns a discriminated union. RedfinTransport's
    // contract is "return on HTTP-level outcomes (including 4xx/5xx),
    // throw on protocol-level failures". Map ok:false to a thrown error.
    if (!result.ok) {
      throw new Error(`fetchproxy transport error: ${result.error}`);
    }
    return { status: result.status, body: result.body, url: result.url };
  }
}

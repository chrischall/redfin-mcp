/**
 * Small URL helpers shared across tools.
 *
 * Redfin's pages are served from a fixed `https://www.redfin.com` origin
 * and the FetchproxyTransport prepends that for us — tools work in terms
 * of paths, not URLs. When a tool accepts a `url` arg from the user, we
 * need to reduce it down to a path before handing it off.
 *
 * `urlToPath` was byte-identical across the cohort, so it now lives in
 * `@chrischall/realty-core` (cohort migration realty-mcp#1). Re-exported
 * here so existing imports (`from '../url.js'`) keep working unchanged.
 */
export { urlToPath } from '@chrischall/realty-core';

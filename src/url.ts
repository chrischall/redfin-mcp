/**
 * Small URL helpers shared across tools.
 *
 * Redfin's pages are served from a fixed `https://www.redfin.com` origin
 * and the FetchproxyTransport prepends that for us — tools work in terms
 * of paths, not URLs. When a tool accepts a `url` arg from the user, we
 * need to reduce it down to a path before handing it off.
 */

/**
 * Reduce a Redfin URL (or path) to its path+search portion.
 *
 * Accepts an absolute URL (any host — we only keep the path), a path
 * starting with `/`, or a bare segment which we coerce to a leading-slash
 * path. Returns the path+search ready to hand to `RedfinClient.fetchHtml`.
 *
 * @example
 *   urlToPath('https://www.redfin.com/home/foo/7_zpid/')
 *     → '/homedetails/foo/7_zpid/'
 *   urlToPath('homedetails/7_zpid/')
 *     → '/homedetails/7_zpid/'
 *   urlToPath('/already/a/path/')
 *     → '/already/a/path/'
 */
export function urlToPath(input: string): string {
  try {
    const u = new URL(input);
    return `${u.pathname}${u.search}`;
  } catch {
    return input.startsWith('/') ? input : `/${input}`;
  }
}

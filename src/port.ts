/**
 * Validate the `REDFIN_WS_PORT` override (fleet-audit #674).
 *
 * `raw` is the value `readEnvVar` already trimmed and placeholder-filtered;
 * `undefined` means unset, so the transport keeps its default (37149).
 * Anything else must be a plain integer in 1..65535. A typo such as
 * `37149x` used to become `Number('37149x')` = NaN and fail later, at bind
 * time, with an error that never named the variable — this fails fast at
 * startup with one that does.
 */
export function resolveWsPort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `REDFIN_WS_PORT must be an integer from 1 to 65535 (got ${JSON.stringify(raw)}). ` +
        'Fix or unset it to use the default port 37149.'
    );
  }
  return port;
}

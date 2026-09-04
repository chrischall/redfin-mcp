import { minifiedResult, resolveView, stripMediaUrls, viewParam, type View } from '@chrischall/mcp-utils';

/**
 * The rungs this server honours (`@chrischall/mcp-utils`' `view` vocabulary;
 * `chrischall/workflows` `docs/fleet-conventions.md`, "Response shape").
 *
 * **What compact does here, and what it deliberately does NOT do.**
 *
 * The read tools in this server hand back Redfin's payload close to
 * verbatim, and the repo holds no verified record of what those payloads
 * contain — no captured fixture, no documented field list. So nothing here can
 * honestly say which of Redfin's fields matter and which are noise.
 *
 * Compact therefore does the one projection that needs no such knowledge: it
 * strips image and avatar URLs. That is SUBTRACTIVE, so it cannot lose a field
 * nobody knew about — the failure an invented field list would risk, where a
 * record comes back with holes in it and reads like a verified answer.
 *
 * When a real payload can be captured, a field projection belongs here beside
 * this one and will save considerably more. Until then this is the honest
 * ceiling, and this docblock says so rather than implying a shape was checked.
 */
export const RF_VIEWS = ['compact', 'full'] as const;

const NOTE =
  'compact strips image/avatar URLs from the response; "full" returns Redfin\'s payload untouched. ' +
  'No field projection: this server has no verified record of which Redfin fields matter, and inventing ' +
  'one would risk dropping a field a caller needs.';

/** The `view` parameter every read tool in this server takes. */
export const viewArg = (): ReturnType<typeof viewParam> => viewParam(RF_VIEWS, { note: NOTE });

/**
 * Answer in the requested rung.
 *
 * Only ever called from a READ tool. A write's response is a receipt — an id,
 * a status — with nothing to strip and everything to keep.
 */
/**
 * `image_url` and `thumbnail_url` are KEPT.
 *
 * `formatHomeCard` CONSTRUCTS them from `mlsId` + `dataSourceId` — they are
 * derived with knowledge of Redfin's URL scheme, not incidental decoration —
 * and `photo_count` beside them is the caller's cue that
 * `redfin_get_property_photos` has more. The blind subtractive rule would have
 * removed both whenever the constructed URL ends in `.jpg`, and the existing
 * tests would NOT have caught it: their fixtures leave those fields unset.
 *
 * The photo tools themselves take no `view` at all — their product IS the
 * `photoUrls` bundle, the one documented way `stripMediaUrls` can be misused.
 */
const KEEP = ['image_url', 'thumbnail_url'] as const;

export function viewResponse(view: string | undefined, data: unknown): ReturnType<typeof minifiedResult> {
  const rung: View = resolveView(view, RF_VIEWS);
  return minifiedResult(rung === 'compact' ? stripMediaUrls(data, { keep: KEEP }) : data);
}

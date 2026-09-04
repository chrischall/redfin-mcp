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

/**
 * `primary_photo_url` is DROPPED — the opposite call from `image_url`, and for
 * the opposite reason.
 *
 * `format()` (`tools/properties.ts`) reads it straight off Redfin's payload:
 * `atf.mediaBrowserInfo.photos[0].photoUrls.fullScreenPhotoUrl`. Nothing here
 * derives it, nothing here knows anything about it — it is an upstream CDN URL
 * this server carries through verbatim, which is precisely the field shape
 * `stripMediaUrls` exists to remove. A model cannot see it, cannot fetch it,
 * and `redfin_get_property_photos` returns the whole gallery for a caller who
 * wants pictures.
 *
 * Naming it explicitly rather than leaving it to the built-in rules is what
 * makes the removal DETERMINISTIC. The key does not match `MEDIA_KEY` (that
 * anchor is at the start of the key, and this one starts `primary_`), so today
 * it is removed only by the VALUE rule — because Redfin's CDN URLs happen to
 * end in `.jpg`. A signed or extension-less URL would silently start surviving
 * compact, and the field would come back with no change here to explain it.
 */
const DROP = ['primary_photo_url'] as const;

export function viewResponse(view: string | undefined, data: unknown): ReturnType<typeof minifiedResult> {
  const rung: View = resolveView(view, RF_VIEWS);
  return minifiedResult(rung === 'compact' ? stripMediaUrls(data, { keep: KEEP, drop: DROP }) : data);
}

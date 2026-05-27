import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COMMUNITIES,
  extractFeatures,
  loadCommunities,
} from '../src/features.js';

describe('extractFeatures', () => {
  const communities = DEFAULT_COMMUNITIES;

  describe('lake_front', () => {
    it('matches "lakefront"', () => {
      expect(extractFeatures('Stunning lakefront home.', communities).lake_front).toBe(true);
    });
    it('matches "lake front" (two words)', () => {
      expect(extractFeatures('Beautiful lake front cottage.', communities).lake_front).toBe(true);
    });
    it('matches "waterfront"', () => {
      expect(extractFeatures('Waterfront views await.', communities).lake_front).toBe(true);
    });
    it('is case-insensitive', () => {
      expect(extractFeatures('LAKEFRONT property.', communities).lake_front).toBe(true);
    });
    it('does not match unrelated words', () => {
      expect(extractFeatures('Near a lake.', communities).lake_front).toBe(false);
    });
  });

  describe('hot_tub', () => {
    it('matches "hot tub"', () => {
      expect(extractFeatures('Outdoor hot tub on the deck.', communities).hot_tub).toBe(true);
    });
    it('does not match "hottub" without space', () => {
      expect(extractFeatures('hottub here.', communities).hot_tub).toBe(false);
    });
    it('does not match "jacuzzi"', () => {
      expect(extractFeatures('Jacuzzi included.', communities).hot_tub).toBe(false);
    });
  });

  describe('basement (REGRESSION-PINNED substring trap)', () => {
    it('returns "unfinished" for "unfinished basement"', () => {
      expect(extractFeatures('Large unfinished basement for storage.', communities).basement).toBe(
        'unfinished'
      );
    });
    it('returns "unfinished" for "the basement is unfinished" (word-reversed)', () => {
      expect(
        extractFeatures('The basement is unfinished but spacious.', communities).basement
      ).toBe('unfinished');
    });
    it('PIN: returns "unfinished" when description has BOTH "finished" qualifier nearby AND "unfinished basement"', () => {
      // The substring trap: "finished basement" appears INSIDE "unfinished basement".
      // If checked in the wrong order, this returns "finished" — bug!
      expect(
        extractFeatures(
          'Finished hardwood floors throughout. The basement is unfinished, ready for buildout.',
          communities
        ).basement
      ).toBe('unfinished');
    });
    it('returns "finished" for "finished basement"', () => {
      expect(extractFeatures('Newly finished basement.', communities).basement).toBe('finished');
    });
    it('returns "partial" for "partially finished basement"', () => {
      expect(
        extractFeatures('Partially finished basement.', communities).basement
      ).toBe('partial');
    });
    it('returns "unknown" when basement is mentioned but no qualifier', () => {
      expect(extractFeatures('Basement is included.', communities).basement).toBe('unknown');
    });
    it('returns null when no basement mention', () => {
      expect(extractFeatures('No mention here.', communities).basement).toBeNull();
    });
  });

  describe('furnished', () => {
    it('returns "fully" for "fully furnished"', () => {
      expect(extractFeatures('Sold fully furnished.', communities).furnished).toBe('fully');
    });
    it('returns "fully" for "turnkey"', () => {
      expect(extractFeatures('Turnkey investment property.', communities).furnished).toBe('fully');
    });
    it('returns "fully" for "sold furnished"', () => {
      expect(extractFeatures('Sold furnished.', communities).furnished).toBe('fully');
    });
    it('returns "partial" for "almost furnished"', () => {
      expect(extractFeatures('Almost furnished, just bring clothes.', communities).furnished).toBe(
        'partial'
      );
    });
    it('returns "partial" for "furnished with exceptions"', () => {
      expect(
        extractFeatures('Furnished with exceptions per the inventory list.', communities).furnished
      ).toBe('partial');
    });
    it('returns "negotiable" for "furnishings negotiable"', () => {
      expect(
        extractFeatures('Furnishings are negotiable.', communities).furnished
      ).toBe('negotiable');
    });
    it('returns null when no furnish mention', () => {
      expect(extractFeatures('No furniture info.', communities).furnished).toBeNull();
    });
  });

  describe('dock (specificity ordering)', () => {
    it('returns "private" for "private boat dock"', () => {
      expect(extractFeatures('Private boat dock included.', communities).dock).toBe('private');
    });
    it('returns "private" over "community" when both mentioned', () => {
      expect(
        extractFeatures(
          'Private dock for the owner, plus a community dock for guests.',
          communities
        ).dock
      ).toBe('private');
    });
    it('returns "community" for "community dock"', () => {
      expect(extractFeatures('Use the community dock.', communities).dock).toBe('community');
    });
    it('returns "community" for "shared dock"', () => {
      expect(extractFeatures('Shared dock with neighbours.', communities).dock).toBe('community');
    });
    it('returns "boat_slip" for "boat slip"', () => {
      expect(extractFeatures('Comes with a boat slip.', communities).dock).toBe('boat_slip');
    });
    it('returns "marina" as the most general fallback', () => {
      expect(extractFeatures('Steps from the marina.', communities).dock).toBe('marina');
    });
    it('returns null when no dock mention', () => {
      expect(extractFeatures('No water access.', communities).dock).toBeNull();
    });
    it('does NOT misclassify place-name "Marina" suffixes as a dock (false-positive pin)', () => {
      expect(
        extractFeatures('Property at 123 Marina Dr with sweeping views.', communities).dock
      ).toBeNull();
      expect(extractFeatures('Just south of Marina Bay.', communities).dock).toBeNull();
      expect(extractFeatures('Marina del Rey area.', communities).dock).toBeNull();
    });
    it('still matches "marina" as a dock signal when not followed by a place-suffix', () => {
      expect(extractFeatures('Marina slip included.', communities).dock).toBe('marina');
    });
  });

  describe('community', () => {
    it('matches a community from the vocabulary', () => {
      expect(extractFeatures('Located in Rumbling Bald.', communities).community).toBe(
        'Rumbling Bald'
      );
    });
    it('is case-insensitive', () => {
      expect(extractFeatures('LIVES IN rumbling bald.', communities).community).toBe(
        'Rumbling Bald'
      );
    });
    it('tolerates trailing punctuation', () => {
      expect(extractFeatures('Located in The Cliffs!', communities).community).toBe('The Cliffs');
    });
    it('returns the earliest mention in document order', () => {
      // "Riverbend at Lake Lure" comes BEFORE "Rumbling Bald" in the text.
      expect(
        extractFeatures(
          'Welcome to Riverbend at Lake Lure! Nearby Rumbling Bald has amenities.',
          communities
        ).community
      ).toBe('Riverbend at Lake Lure');
    });
    it('returns the earliest mention even when reversed in text', () => {
      expect(
        extractFeatures(
          'Near Rumbling Bald, but property is in Riverbend at Lake Lure.',
          communities
        ).community
      ).toBe('Rumbling Bald');
    });
    it('returns null when no community matches', () => {
      expect(extractFeatures('Random street.', communities).community).toBeNull();
    });
  });

  it('returns all-falsy/null shape for empty description', () => {
    const f = extractFeatures(undefined, communities);
    expect(f.lake_front).toBe(false);
    expect(f.hot_tub).toBe(false);
    expect(f.basement).toBeNull();
    expect(f.furnished).toBeNull();
    expect(f.dock).toBeNull();
    expect(f.community).toBeNull();
  });
});

describe('loadCommunities', () => {
  const ORIG_ENV = process.env.REDFIN_COMMUNITIES_FILE;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.REDFIN_COMMUNITIES_FILE;
    else process.env.REDFIN_COMMUNITIES_FILE = ORIG_ENV;
    warnSpy.mockRestore();
  });

  it('returns DEFAULT_COMMUNITIES when env var is unset', () => {
    delete process.env.REDFIN_COMMUNITIES_FILE;
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
  });

  it('returns DEFAULT_COMMUNITIES + warns when file does not exist', () => {
    process.env.REDFIN_COMMUNITIES_FILE = '/no/such/path/communities.json';
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/not found/));
  });

  it('loads the JSON array when valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redfin-comm-'));
    const path = join(dir, 'communities.json');
    writeFileSync(path, JSON.stringify(['Acme Village', 'Pinetop Estates']));
    process.env.REDFIN_COMMUNITIES_FILE = path;
    try {
      expect(loadCommunities()).toEqual(['Acme Village', 'Pinetop Estates']);
    } finally {
      unlinkSync(path);
    }
  });

  it('falls back + warns on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redfin-comm-'));
    const path = join(dir, 'communities.json');
    writeFileSync(path, 'not json at all');
    process.env.REDFIN_COMMUNITIES_FILE = path;
    try {
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      unlinkSync(path);
    }
  });

  it('falls back + warns when JSON is not a string array', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redfin-comm-'));
    const path = join(dir, 'communities.json');
    writeFileSync(path, JSON.stringify({ not: 'an array' }));
    process.env.REDFIN_COMMUNITIES_FILE = path;
    try {
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/must be a JSON string array/)
      );
    } finally {
      unlinkSync(path);
    }
  });
});

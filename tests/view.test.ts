import { describe, it, expect } from 'vitest';
import { viewResponse, RF_VIEWS } from '../src/view.js';

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe('the rungs', () => {
  it('offers compact and full, and not raw', () => {
    expect(RF_VIEWS).toEqual(['compact', 'full']);
  });

  it('defaults to compact', () => {
    expect(parse(viewResponse(undefined, { id: 1, avatar: 'https://cdn/a.png' }))).toEqual({ id: 1 });
  });
});

describe('the constructed photo fields survive compact', () => {
  /**
   * The regression this file exists for. `formatHomeCard` CONSTRUCTS
   * `image_url` and `thumbnail_url` from mlsId + dataSourceId — derived with
   * knowledge of Redfin's URL scheme, not incidental decoration. The blind
   * media rule removes any URL ending in `.jpg`, so without an explicit `keep`
   * both vanished from every saved-home record.
   *
   * The existing suite could not catch it: its fixtures leave those fields
   * unset. Hence a test with them set.
   */
  const card = {
    address: '1 Main St',
    price: 500000,
    image_url: 'https://ssl.cdn-redfin.com/photo/1/bigphoto/066/x.jpg',
    thumbnail_url: 'https://ssl.cdn-redfin.com/photo/1/mbphoto/066/x.jpg',
    photo_count: 32,
  };

  it('keeps image_url and thumbnail_url on the compact rung', () => {
    expect(parse(viewResponse('compact', card))).toEqual(card);
  });

  it('keeps them inside an array of cards too', () => {
    expect(parse(viewResponse('compact', [card, card]))).toEqual([card, card]);
  });

  it('still strips an incidental avatar beside them', () => {
    const withAvatar = { ...card, agent: { name: 'A', avatar: 'https://cdn/a.png' } };
    expect(parse(viewResponse('compact', withAvatar))).toEqual({ ...card, agent: { name: 'A' } });
  });

  it('full returns everything untouched', () => {
    expect(parse(viewResponse('full', card))).toEqual(card);
  });
});

describe('whitespace', () => {
  it('emits none of its own, and never touches whitespace inside a value', () => {
    const remarks = 'Charming.\n\n  Needs work.   ';
    const text = viewResponse('compact', { remarks }).content[0].text;
    expect(text.split('\n')).toHaveLength(1);
    expect(JSON.parse(text).remarks).toBe(remarks);
  });
});

import { describe, it, expect } from 'vitest';
import { expandAddressVariants, listVariants } from '../src/suffix.js';

describe('expandAddressVariants', () => {
  it('CANONICAL REGRESSION: 268 Mallard Rd ↔ Road', () => {
    expect(
      expandAddressVariants('268 Mallard Rd, Lake Lure NC 28746')
    ).toEqual([
      '268 Mallard Rd, Lake Lure NC 28746',
      '268 Mallard Road, Lake Lure NC 28746',
    ]);
    expect(
      expandAddressVariants('268 Mallard Road, Lake Lure NC 28746')
    ).toEqual([
      '268 Mallard Road, Lake Lure NC 28746',
      '268 Mallard Rd, Lake Lure NC 28746',
    ]);
  });

  it('expands Ln → Lane and back', () => {
    expect(expandAddressVariants('126 Sleeping Bear Ln, X, NC')).toContain(
      '126 Sleeping Bear Lane, X, NC'
    );
    expect(expandAddressVariants('126 Sleeping Bear Lane, X, NC')).toContain(
      '126 Sleeping Bear Ln, X, NC'
    );
  });

  it('expands Dr ↔ Drive, Ct ↔ Court, Blvd ↔ Boulevard, Cir ↔ Circle, Hwy ↔ Highway, Pkwy ↔ Parkway', () => {
    expect(expandAddressVariants('1 X Dr')).toEqual(['1 X Dr', '1 X Drive']);
    expect(expandAddressVariants('1 X Ct')).toEqual(['1 X Ct', '1 X Court']);
    expect(expandAddressVariants('1 X Blvd')).toEqual(['1 X Blvd', '1 X Boulevard']);
    expect(expandAddressVariants('1 X Cir')).toEqual(['1 X Cir', '1 X Circle']);
    expect(expandAddressVariants('1 X Hwy')).toEqual(['1 X Hwy', '1 X Highway']);
    expect(expandAddressVariants('1 X Pkwy')).toEqual(['1 X Pkwy', '1 X Parkway']);
  });

  it('expands Ave ↔ Avenue, St ↔ Street, Pl ↔ Place, Trl ↔ Trail', () => {
    expect(expandAddressVariants('1 X Ave')).toEqual(['1 X Ave', '1 X Avenue']);
    expect(expandAddressVariants('1 X St')).toEqual(['1 X St', '1 X Street']);
    expect(expandAddressVariants('1 X Pl')).toEqual(['1 X Pl', '1 X Place']);
    expect(expandAddressVariants('1 X Trl')).toEqual(['1 X Trl', '1 X Trail']);
  });

  it('handles trailing punctuation on the suffix', () => {
    expect(expandAddressVariants('268 Mallard Rd.,Lake Lure')).toContain(
      '268 Mallard Road.,Lake Lure'
    );
  });

  it('lowercase suffix → lowercase expansion', () => {
    expect(expandAddressVariants('1 X rd')).toEqual(['1 X rd', '1 X road']);
  });

  it('returns just the input when no suffix swap applies', () => {
    expect(expandAddressVariants('1 Cannot Match XYZ')).toEqual([
      '1 Cannot Match XYZ',
    ]);
  });

  it('dedupes when suffix swap collides with input', () => {
    // "Way" maps to itself in the table.
    expect(expandAddressVariants('1 Test Way')).toEqual(['1 Test Way']);
  });

  it('handles empty string', () => {
    expect(expandAddressVariants('')).toEqual([]);
  });
});

describe('listVariants', () => {
  it('returns primary + alternates', () => {
    const v = listVariants('268 Mallard Rd, Lake Lure NC 28746');
    expect(v.primary).toBe('268 Mallard Rd, Lake Lure NC 28746');
    expect(v.alternates).toEqual(['268 Mallard Road, Lake Lure NC 28746']);
  });

  it('alternates is empty when no swap applies', () => {
    const v = listVariants('XYZ');
    expect(v.alternates).toEqual([]);
  });
});

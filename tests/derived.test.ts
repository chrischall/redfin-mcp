import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildPortalUrlHyperlink,
  cleanTaxAnnual,
  collectAddressAlternates,
  hoaToMonthlyUsd,
  lastSold,
  priceDrop,
} from '../src/derived.js';

describe('hoaToMonthlyUsd', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    warnSpy?.mockRestore();
  });
  it('Monthly passes through', () => {
    expect(hoaToMonthlyUsd(400, 'Monthly')).toBe(400);
  });
  it('Annually divides by 12 and rounds', () => {
    expect(hoaToMonthlyUsd(4967, 'Annually')).toBe(414);
  });
  it('Quarterly divides by 3', () => {
    expect(hoaToMonthlyUsd(900, 'Quarterly')).toBe(300);
  });
  it('SemiAnnually divides by 6', () => {
    expect(hoaToMonthlyUsd(1200, 'SemiAnnually')).toBe(200);
  });
  it('Weekly converts via *52/12', () => {
    expect(hoaToMonthlyUsd(100, 'Weekly')).toBe(Math.round((100 * 52) / 12));
  });
  it('null amount → null', () => {
    expect(hoaToMonthlyUsd(undefined, 'Monthly')).toBeNull();
    expect(hoaToMonthlyUsd(null, 'Monthly')).toBeNull();
  });
  it('null frequency → null', () => {
    expect(hoaToMonthlyUsd(100, undefined)).toBeNull();
  });
  it('unknown frequency → null + warn', () => {
    warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(hoaToMonthlyUsd(100, 'Biweekly')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/unknown HOA frequency/));
  });
});

describe('priceDrop', () => {
  it('500k → 480k is 20k / 4.0%', () => {
    expect(priceDrop(480_000, 500_000)).toEqual({
      price_drop_amount: 20_000,
      price_drop_percent: 4.0,
    });
  });
  it('rounds percent to 0.1', () => {
    expect(priceDrop(995_000, 1_000_000)).toEqual({
      price_drop_amount: 5_000,
      price_drop_percent: 0.5,
    });
  });
  it('null current → both null', () => {
    expect(priceDrop(undefined, 500_000)).toEqual({
      price_drop_amount: null,
      price_drop_percent: null,
    });
  });
  it('null previous → both null', () => {
    expect(priceDrop(500_000, undefined)).toEqual({
      price_drop_amount: null,
      price_drop_percent: null,
    });
  });
  it('zero previous (div-by-zero guard) → both null', () => {
    expect(priceDrop(100, 0)).toEqual({
      price_drop_amount: null,
      price_drop_percent: null,
    });
  });
});

describe('cleanTaxAnnual', () => {
  it('null raw → both null', () => {
    expect(cleanTaxAnnual(undefined)).toEqual({ tax_annual: null, tax_status: null });
  });
  it('0 → not_yet_assessed sentinel', () => {
    expect(cleanTaxAnnual(0)).toEqual({ tax_annual: null, tax_status: 'not_yet_assessed' });
  });
  it('1 → not_yet_assessed sentinel', () => {
    expect(cleanTaxAnnual(1)).toEqual({ tax_annual: null, tax_status: 'not_yet_assessed' });
  });
  it('real value passes through', () => {
    expect(cleanTaxAnnual(5400)).toEqual({ tax_annual: 5400, tax_status: null });
  });
});

describe('buildPortalUrlHyperlink', () => {
  it('returns a Sheets =HYPERLINK formula with "Redfin" label', () => {
    expect(
      buildPortalUrlHyperlink(
        'https://www.redfin.com/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345'
      )
    ).toBe(
      '=HYPERLINK("https://www.redfin.com/NC/Lake-Lure/268-Mallard-Rd-28746/home/12345","Redfin")'
    );
  });
  it('escapes embedded double quotes', () => {
    expect(buildPortalUrlHyperlink('https://x.com/?q=a"b')).toContain('a""b');
  });
});

describe('collectAddressAlternates', () => {
  it('returns empty when no candidates', () => {
    expect(collectAddressAlternates('1 Main St, X', [])).toEqual([]);
  });
  it('excludes candidates equal (after normalization) to primary', () => {
    expect(
      collectAddressAlternates('1 Main St, Anywhere', ['1 main st, anywhere'])
    ).toEqual([]);
  });
  it('emits genuinely-different candidates', () => {
    expect(
      collectAddressAlternates('109 Overlook Point Ln', ['169 Overlook Point Ln'])
    ).toEqual(['169 Overlook Point Ln']);
  });
  it('dedupes equivalent candidates', () => {
    expect(
      collectAddressAlternates('1 Main St', ['2 Side St', '2 SIDE ST.', '2 Side St'])
    ).toEqual(['2 Side St']);
  });
  it('ignores null/empty candidates', () => {
    expect(
      collectAddressAlternates('1 Main', [undefined, null, '', '2 Side'])
    ).toEqual(['2 Side']);
  });
});

describe('lastSold', () => {
  it('finds the most recent Sold event by date', () => {
    const events = [
      { eventDescription: 'Listed', eventDate: 100, price: 600_000 },
      { eventDescription: 'Sold (MLS)', eventDate: 200, price: 550_000 },
      { eventDescription: 'Sold (Public Records)', eventDate: 50, price: 400_000 },
    ];
    const out = lastSold(events);
    expect(out.last_sold_price).toBe(550_000);
    // 200 unix ms is 1970-01-01.
    expect(out.last_sold_date).toBe('1970-01-01');
  });
  it('returns nulls when no Sold event', () => {
    expect(lastSold([{ eventDescription: 'Listed', eventDate: 100, price: 600_000 }])).toEqual(
      { last_sold_date: null, last_sold_price: null }
    );
  });
  it('returns nulls for empty list', () => {
    expect(lastSold([])).toEqual({ last_sold_date: null, last_sold_price: null });
  });
  it('matches "sold" case-insensitively', () => {
    expect(
      lastSold([{ eventDescription: 'SOLD', eventDate: 1_700_000_000_000, price: 100 }])
        .last_sold_price
    ).toBe(100);
  });
});

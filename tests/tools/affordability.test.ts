import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  computeAffordability,
  registerAffordabilityTools,
} from '../../src/tools/affordability.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

describe('computeAffordability', () => {
  it('binds on front-end (28%) when debts are light', () => {
    const r = computeAffordability({
      monthly_income: 10_000,
      down_payment: 100_000,
      interest_rate: 6.5,
    });
    expect(r.binding_constraint).toBe('front_end');
    expect(r.max_monthly_piti).toBe(2800);
  });

  it('binds on back-end (36%) when debts are heavy', () => {
    const r = computeAffordability({
      monthly_income: 10_000,
      monthly_debts: 2000,
      down_payment: 100_000,
      interest_rate: 6.5,
    });
    expect(r.binding_constraint).toBe('back_end');
    expect(r.max_monthly_piti).toBe(1600);
  });

  it('max_home_price scales with down_payment monotonically', () => {
    const base = { monthly_income: 8000, interest_rate: 6 };
    const a = computeAffordability({ ...base, down_payment: 50_000 });
    const b = computeAffordability({ ...base, down_payment: 200_000 });
    expect(b.max_home_price).toBeGreaterThan(a.max_home_price);
  });

  it('rejects bad inputs', () => {
    expect(() =>
      computeAffordability({
        monthly_income: 0,
        down_payment: 100,
        interest_rate: 5,
      })
    ).toThrow(/monthly_income/);
    expect(() =>
      computeAffordability({
        monthly_income: 5000,
        down_payment: -1,
        interest_rate: 5,
      })
    ).toThrow(/down_payment/);
    expect(() =>
      computeAffordability({
        monthly_income: 5000,
        down_payment: 100,
        interest_rate: -1,
      })
    ).toThrow(/interest_rate/);
  });

  it('handles 0% interest rate', () => {
    const r = computeAffordability({
      monthly_income: 5000,
      down_payment: 100_000,
      interest_rate: 0,
    });
    expect(r.max_home_price).toBeGreaterThan(100_000);
  });
});

describe('redfin_calculate_affordability tool', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  beforeAll(async () => {
    h = await createTestHarness((server) => registerAffordabilityTools(server));
  });
  afterAll(async () => {
    await h.close();
  });

  it('returns max price + PITI breakdown via the MCP boundary', async () => {
    const r = await h.callTool('redfin_calculate_affordability', {
      monthly_income: 12_000,
      down_payment: 150_000,
      interest_rate: 6.5,
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      max_home_price: number;
      max_monthly_piti: number;
    }>(r);
    expect(parsed.max_home_price).toBeGreaterThan(0);
    expect(parsed.max_monthly_piti).toBe(3360); // 12000 * 0.28
  });
});

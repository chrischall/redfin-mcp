import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  computeMortgage,
  registerMortgageTools,
} from '../../src/tools/mortgage.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

describe('computeMortgage', () => {
  it('computes the canonical 30-year fixed P&I', () => {
    // $300k loan @ 6% / 30y → $1,798.65/mo (industry standard reference)
    const b = computeMortgage({
      home_price: 300_000,
      down_payment: 0,
      interest_rate: 6,
      loan_term_years: 30,
    });
    expect(b.loan_amount).toBe(300_000);
    expect(b.monthly_principal_interest).toBeCloseTo(1798.65, 1);
  });

  it('defaults to 20% down when neither down field is given', () => {
    const b = computeMortgage({
      home_price: 500_000,
      interest_rate: 5,
    });
    expect(b.down_payment).toBe(100_000);
    expect(b.loan_amount).toBe(400_000);
  });

  it('honors down_payment_percent', () => {
    const b = computeMortgage({
      home_price: 500_000,
      down_payment_percent: 10,
      interest_rate: 5,
    });
    expect(b.down_payment).toBe(50_000);
    expect(b.loan_amount).toBe(450_000);
    expect(b.ltv_percent).toBe(90);
  });

  it('handles a 0% interest rate without divide-by-zero', () => {
    const b = computeMortgage({
      home_price: 240_000,
      down_payment: 0,
      interest_rate: 0,
      loan_term_years: 20,
    });
    // 240_000 / 240 months = 1000/mo
    expect(b.monthly_principal_interest).toBe(1000);
    expect(b.total_interest_paid).toBe(0);
  });

  it('rolls property tax and insurance into the monthly total', () => {
    const b = computeMortgage({
      home_price: 500_000,
      down_payment_percent: 20,
      interest_rate: 6,
      property_tax_annual: 6_000,
      insurance_annual: 1_200,
      hoa_monthly: 250,
    });
    expect(b.monthly_property_tax).toBe(500); // 6000/12
    expect(b.monthly_insurance).toBe(100); // 1200/12
    expect(b.monthly_hoa).toBe(250);
    expect(b.monthly_total).toBeCloseTo(
      b.monthly_principal_interest + 500 + 100 + 250,
      1
    );
  });

  it('translates property_tax_rate to a monthly figure', () => {
    const b = computeMortgage({
      home_price: 400_000,
      interest_rate: 5,
      property_tax_rate: 1.2, // 1.2% annually
    });
    // 400_000 * 0.012 / 12 = 400/mo
    expect(b.monthly_property_tax).toBe(400);
  });

  it('only applies PMI when LTV > 80%', () => {
    const above = computeMortgage({
      home_price: 400_000,
      down_payment_percent: 10, // LTV 90%
      interest_rate: 6,
      pmi_rate: 0.5,
    });
    const below = computeMortgage({
      home_price: 400_000,
      down_payment_percent: 20, // LTV 80%
      interest_rate: 6,
      pmi_rate: 0.5,
    });
    expect(above.monthly_pmi).toBeGreaterThan(0);
    expect(below.monthly_pmi).toBe(0);
  });

  it('rejects non-positive home_price', () => {
    expect(() =>
      computeMortgage({ home_price: 0, interest_rate: 5 })
    ).toThrow(/home_price/);
  });

  it('rejects negative interest_rate', () => {
    expect(() =>
      computeMortgage({ home_price: 100_000, interest_rate: -1 })
    ).toThrow(/interest_rate/);
  });

  it('rejects zero or negative loan_term_years', () => {
    expect(() =>
      computeMortgage({
        home_price: 100_000,
        interest_rate: 5,
        loan_term_years: 0,
      })
    ).toThrow(/loan_term_years/);
  });
});

describe('redfin_calculate_mortgage tool', () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>>;
  beforeAll(async () => {
    harness = await createTestHarness((server) => registerMortgageTools(server));
  });
  afterAll(async () => {
    await harness.close();
  });

  it('returns a full PITI breakdown via the MCP boundary', async () => {
    const result = await harness.callTool('redfin_calculate_mortgage', {
      home_price: 500_000,
      down_payment_percent: 20,
      interest_rate: 6,
      loan_term_years: 30,
      property_tax_annual: 6_000,
      insurance_annual: 1_200,
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult<{
      loan_amount: number;
      monthly_principal_interest: number;
      monthly_total: number;
    }>(result);
    expect(parsed.loan_amount).toBe(400_000);
    expect(parsed.monthly_principal_interest).toBeGreaterThan(0);
    expect(parsed.monthly_total).toBeGreaterThan(
      parsed.monthly_principal_interest
    );
  });
});

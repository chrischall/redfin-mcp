import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../mcp.js';

/**
 * Local-only mortgage payment calculator. Parity with sap156/redfin-mcp-
 * server's `calculate_mortgage`. No network — entirely deterministic so
 * the model can reason about scenarios without burning a fetch.
 *
 * Computes the canonical PITI breakdown:
 *   P&I        — principal + interest via the amortization formula
 *   Taxes      — property tax (annual / 12)
 *   Insurance  — homeowner's insurance (annual / 12)
 *   HOA        — monthly HOA dues
 *   PMI        — when LTV > 80% and pmi_rate provided
 */

export interface MortgageInput {
  home_price: number;
  down_payment?: number;
  down_payment_percent?: number;
  interest_rate: number; // annual %, e.g. 6.5
  loan_term_years?: number;
  property_tax_annual?: number;
  property_tax_rate?: number; // % of home_price annually, alternative to property_tax_annual
  insurance_annual?: number;
  hoa_monthly?: number;
  pmi_rate?: number; // annual % of loan balance
}

export interface MortgageBreakdown {
  loan_amount: number;
  down_payment: number;
  monthly_principal_interest: number;
  monthly_property_tax: number;
  monthly_insurance: number;
  monthly_hoa: number;
  monthly_pmi: number;
  monthly_total: number;
  total_interest_paid: number;
  total_paid_over_loan: number;
  loan_term_years: number;
  interest_rate: number;
  ltv_percent: number;
}

export function computeMortgage(input: MortgageInput): MortgageBreakdown {
  if (input.home_price <= 0) {
    throw new Error('home_price must be positive');
  }
  if (input.interest_rate < 0) {
    throw new Error('interest_rate must be non-negative');
  }
  const term_years = input.loan_term_years ?? 30;
  if (term_years <= 0) throw new Error('loan_term_years must be positive');

  const down =
    input.down_payment !== undefined
      ? input.down_payment
      : input.down_payment_percent !== undefined
        ? (input.home_price * input.down_payment_percent) / 100
        : input.home_price * 0.2;
  const loan = Math.max(0, input.home_price - down);

  const monthly_rate = input.interest_rate / 100 / 12;
  const n_months = term_years * 12;

  // Amortization formula. Guard rate==0 (no-interest loan).
  let monthly_pi: number;
  if (monthly_rate === 0) {
    monthly_pi = loan / n_months;
  } else {
    const factor = Math.pow(1 + monthly_rate, n_months);
    monthly_pi = (loan * monthly_rate * factor) / (factor - 1);
  }

  const monthly_tax =
    input.property_tax_annual !== undefined
      ? input.property_tax_annual / 12
      : input.property_tax_rate !== undefined
        ? (input.home_price * input.property_tax_rate) / 100 / 12
        : 0;
  const monthly_ins = (input.insurance_annual ?? 0) / 12;
  const monthly_hoa = input.hoa_monthly ?? 0;

  // PMI applies when LTV > 80%. Computed against the loan balance.
  const ltv = (loan / input.home_price) * 100;
  const monthly_pmi =
    input.pmi_rate !== undefined && ltv > 80
      ? (loan * input.pmi_rate) / 100 / 12
      : 0;

  const total_interest = monthly_pi * n_months - loan;
  const total_paid = monthly_pi * n_months;

  return {
    loan_amount: round2(loan),
    down_payment: round2(down),
    monthly_principal_interest: round2(monthly_pi),
    monthly_property_tax: round2(monthly_tax),
    monthly_insurance: round2(monthly_ins),
    monthly_hoa: round2(monthly_hoa),
    monthly_pmi: round2(monthly_pmi),
    monthly_total: round2(
      monthly_pi + monthly_tax + monthly_ins + monthly_hoa + monthly_pmi
    ),
    total_interest_paid: round2(total_interest),
    total_paid_over_loan: round2(total_paid),
    loan_term_years: term_years,
    interest_rate: input.interest_rate,
    ltv_percent: round2(ltv),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function registerMortgageTools(server: McpServer): void {
  server.registerTool(
    'redfin_calculate_mortgage',
    {
      title: 'Calculate mortgage payment (local)',
      description:
        'Local-only mortgage payment calculator. Returns a full PITI breakdown (principal + interest, property tax, insurance, HOA, PMI) and total interest over the life of the loan. No network call — fully deterministic, safe to use for scenario comparison without burning a fetch. Provide either down_payment OR down_payment_percent; defaults to 20%. Property tax can be given as property_tax_annual or property_tax_rate (% of home price). PMI applies automatically when LTV > 80% and pmi_rate is provided.',
      annotations: {
        title: 'Calculate mortgage payment (local)',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        home_price: z.number().positive(),
        down_payment: z.number().nonnegative().optional(),
        down_payment_percent: z.number().nonnegative().max(100).optional(),
        interest_rate: z.number().nonnegative().describe('Annual %, e.g. 6.5'),
        loan_term_years: z.number().int().positive().optional().describe('Default 30'),
        property_tax_annual: z.number().nonnegative().optional(),
        property_tax_rate: z.number().nonnegative().optional().describe('Annual % of home price'),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        pmi_rate: z.number().nonnegative().optional().describe('Annual %, applied when LTV > 80%'),
      },
    },
    async (input) => textResult(computeMortgage(input as MortgageInput))
  );
}

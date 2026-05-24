import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../mcp.js';

/**
 * Local affordability calculator. No network — just standard 28/36 DTI
 * math. Mirrors the zillow-mcp tool of the same name so callers can
 * switch back-ends transparently.
 */

export interface AffordabilityInput {
  monthly_income: number;
  monthly_debts?: number;
  down_payment: number;
  interest_rate: number;
  loan_term_years?: number;
  property_tax_rate?: number;
  insurance_annual?: number;
  hoa_monthly?: number;
  front_end_dti?: number;
  back_end_dti?: number;
}

export interface AffordabilityResult {
  max_home_price: number;
  max_monthly_piti: number;
  binding_constraint: 'front_end' | 'back_end';
  monthly_principal_interest: number;
  monthly_property_tax: number;
  monthly_insurance: number;
  monthly_hoa: number;
  loan_amount: number;
  down_payment: number;
  front_end_dti_used: number;
  back_end_dti_used: number;
}

export function computeAffordability(
  input: AffordabilityInput
): AffordabilityResult {
  if (input.monthly_income <= 0)
    throw new Error('monthly_income must be positive');
  if (input.down_payment < 0) throw new Error('down_payment must be >= 0');
  if (input.interest_rate < 0)
    throw new Error('interest_rate must be >= 0');

  const term_years = input.loan_term_years ?? 30;
  const monthly_debts = input.monthly_debts ?? 0;
  const front_dti = input.front_end_dti ?? 0.28;
  const back_dti = input.back_end_dti ?? 0.36;
  const tax_rate = input.property_tax_rate ?? 1.1;
  const insurance_annual = input.insurance_annual ?? 0;
  const hoa_monthly = input.hoa_monthly ?? 0;

  const front_max = input.monthly_income * front_dti;
  const back_max = input.monthly_income * back_dti - monthly_debts;
  const max_piti = Math.max(0, Math.min(front_max, back_max));
  const binding: 'front_end' | 'back_end' =
    front_max <= back_max ? 'front_end' : 'back_end';

  const monthly_ins = insurance_annual / 12;
  const monthly_tax_per_dollar = tax_rate / 100 / 12;
  const monthly_pi_budget = Math.max(0, max_piti - monthly_ins - hoa_monthly);

  const r = input.interest_rate / 100 / 12;
  const n = term_years * 12;
  const factor =
    r === 0 ? 1 / n : (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);

  const coeff = monthly_tax_per_dollar + factor;
  const max_home_price =
    coeff === 0
      ? input.down_payment
      : (monthly_pi_budget + input.down_payment * factor) / coeff;

  const loan_amount = Math.max(0, max_home_price - input.down_payment);
  const monthly_pi = r === 0 ? loan_amount / n : loan_amount * factor;
  const monthly_tax = max_home_price * monthly_tax_per_dollar;

  return {
    max_home_price: round2(max_home_price),
    max_monthly_piti: round2(max_piti),
    binding_constraint: binding,
    monthly_principal_interest: round2(monthly_pi),
    monthly_property_tax: round2(monthly_tax),
    monthly_insurance: round2(monthly_ins),
    monthly_hoa: round2(hoa_monthly),
    loan_amount: round2(loan_amount),
    down_payment: round2(input.down_payment),
    front_end_dti_used: front_dti,
    back_end_dti_used: back_dti,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function registerAffordabilityTools(server: McpServer): void {
  server.registerTool(
    'redfin_calculate_affordability',
    {
      title: 'Calculate max affordable home price',
      description:
        "Solve for the maximum home price you can afford under the standard 28/36 DTI rule. Inputs: monthly income, recurring monthly debts (car/student loans), down payment, interest rate, optional property-tax rate / insurance / HOA / loan term. Output: max home price, binding constraint (front-end vs back-end), and the PITI breakdown at that price. Identical math to zillow-mcp's tool of the same name. No network — pure local math.",
      annotations: {
        title: 'Calculate max affordable home price',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        monthly_income: z.number().positive(),
        monthly_debts: z.number().nonnegative().optional(),
        down_payment: z.number().nonnegative(),
        interest_rate: z.number().nonnegative(),
        loan_term_years: z.number().int().positive().optional(),
        property_tax_rate: z.number().nonnegative().optional(),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        front_end_dti: z.number().positive().max(1).optional(),
        back_end_dti: z.number().positive().max(1).optional(),
      },
    },
    async (input) => textResult(computeAffordability(input as AffordabilityInput))
  );
}

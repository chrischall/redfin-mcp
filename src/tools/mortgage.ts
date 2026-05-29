import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calculateMortgage } from '@chrischall/realty-core';
import type {
  MortgageInput,
  MortgageBreakdown,
} from '@chrischall/realty-core';
import { textResult } from '../mcp.js';

/**
 * Local-only mortgage payment calculator. The PITI math is canonical in
 * `@chrischall/realty-core`'s `calculateMortgage` — realty-core
 * reconciled the five cohort copies (zillow / redfin / compass / homes /
 * onehome) and explicitly names redfin's `computeMortgage` as one of the
 * surveyed sources; the math is byte-identical. No network — entirely
 * deterministic so the model can reason about scenarios without burning
 * a fetch.
 *
 * Computes the canonical PITI breakdown:
 *   P&I        — principal + interest via the amortization formula
 *   Taxes      — property tax (annual / 12)
 *   Insurance  — homeowner's insurance (annual / 12)
 *   HOA        — monthly HOA dues
 *   PMI        — when LTV > 80% and pmi_rate provided
 *
 * The output is realty-core's `MortgageBreakdown`, a SUPERSET of redfin's
 * historical shape — it adds `home_price` (echoed from input) while every
 * legacy field keeps the same name and value, so existing callers see no
 * regression.
 */

// Re-exported under the local names redfin's tool + tests have always
// used. `computeMortgage` is now a thin alias for the canonical core.
export type { MortgageInput, MortgageBreakdown } from '@chrischall/realty-core';

export function computeMortgage(input: MortgageInput): MortgageBreakdown {
  return calculateMortgage(input);
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

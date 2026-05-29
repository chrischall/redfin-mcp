import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calculateAffordability } from '@chrischall/realty-core';
import type {
  AffordabilityInput,
  AffordabilityResult,
} from '@chrischall/realty-core';
import { textResult } from '../mcp.js';

/**
 * Local affordability calculator. The 28/36 DTI math is canonical in
 * `@chrischall/realty-core`'s `calculateAffordability` — realty-core
 * hoisted the identical cohort copies (zillow / redfin / compass / homes /
 * onehome) into one helper, so this is a byte-identical drop-in. No
 * network — just standard 28/36 DTI math. The input/output shapes are
 * unchanged (realty-core's `AffordabilityInput` / `AffordabilityResult`
 * are field-for-field the same as redfin's historical types).
 */

// Re-exported under the local names redfin's tool + tests have always
// used. `computeAffordability` is now a thin alias for the canonical core.
export type {
  AffordabilityInput,
  AffordabilityResult,
} from '@chrischall/realty-core';

export function computeAffordability(
  input: AffordabilityInput
): AffordabilityResult {
  return calculateAffordability(input);
}

export function registerAffordabilityTools(server: McpServer): void {
  server.registerTool(
    'redfin_calculate_affordability',
    {
      title: 'Calculate max affordable home price',
      description:
        "Solve for the maximum home price you can afford under the standard 28/36 DTI rule. Inputs: monthly income, recurring monthly debts (car/student loans), down payment, interest rate, optional property-tax rate / insurance / HOA / loan term. Output: max home price, binding constraint (front-end vs back-end), and the PITI breakdown at that price. Uses the canonical @chrischall/realty-core affordability engine shared across the realty MCP cohort. No network — pure local math.",
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

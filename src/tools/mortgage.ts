import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { calculateMortgage, registerMortgageTool } from '@chrischall/realty-core';
import type {
  MortgageInput,
  MortgageBreakdown,
} from '@chrischall/realty-core';
import { minifiedResult } from '../mcp.js';

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
  // realty-core's shared registrar (fleet-audit#1090), canonical shape —
  // redfin's output already was realty-core's `MortgageBreakdown`. Adds
  // the MAX_LOAN_TERM_YEARS cap on `loan_term_years`.
  registerMortgageTool(server, {
    z,
    prefix: 'redfin',
    shape: 'canonical',
    toResult: minifiedResult,
  });
}

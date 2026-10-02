import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { calculateAffordability, registerAffordabilityTool } from '@chrischall/realty-core';
import type {
  AffordabilityInput,
  AffordabilityResult,
} from '@chrischall/realty-core';
import { minifiedResult } from '../mcp.js';

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
  // realty-core's shared registrar (fleet-audit#1090): same schema and DTI
  // bounds redfin had, plus the MAX_LOAN_TERM_YEARS cap.
  registerAffordabilityTool(server, {
    z,
    prefix: 'redfin',
    toResult: minifiedResult,
  });
}

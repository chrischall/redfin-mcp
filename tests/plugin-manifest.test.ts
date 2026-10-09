// Invariant: .claude-plugin/plugin.json declares its MCP config under
// `mcpServers` — the key Claude Code reads. A bare `mcp` key is ignored at load
// time (`claude plugin validate`: "Unknown field 'mcp'"); it only appeared to
// work here because ./.mcp.json is the default location anyway. Sibling repos
// copied the pattern with a non-default path and broke their plugin installs.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(
  readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
) as Record<string, unknown>;

describe('.claude-plugin/plugin.json', () => {
  it('declares its MCP config under mcpServers, not the ignored mcp key', () => {
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin.mcpServers).toBe('./.mcp.json');
  });

  it('points mcpServers at a file that exists and defines servers', () => {
    const target = join(ROOT, plugin.mcpServers as string);
    expect(existsSync(target)).toBe(true);
    const config = JSON.parse(readFileSync(target, 'utf8')) as { mcpServers?: object };
    expect(Object.keys(config.mcpServers ?? {}).length).toBeGreaterThan(0);
  });
});

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { ProviderMcpServer } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Read-only MCP stub for gjc.
 *
 * The on-disk location/format of gjc MCP configuration is not yet integrated,
 * so this exposes an empty server list for every supported scope and rejects
 * writes. It keeps the MCP UI functional without guessing at a config format.
 */
export class GjcMcpProvider extends McpProvider {
  constructor() {
    super('gjc', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(): Promise<Record<string, unknown>> {
    return {};
  }

  protected async writeScopedServers(): Promise<void> {
    throw new AppError('gjc MCP configuration is not supported yet.', {
      code: 'MCP_WRITE_UNSUPPORTED',
      statusCode: 400,
    });
  }

  protected buildServerConfig(): Record<string, unknown> {
    throw new AppError('gjc MCP configuration is not supported yet.', {
      code: 'MCP_WRITE_UNSUPPORTED',
      statusCode: 400,
    });
  }

  protected normalizeServerConfig(): ProviderMcpServer | null {
    return null;
  }
}

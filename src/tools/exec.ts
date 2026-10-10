import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  execSshCommandWithConnection,
  type SSHConnectionManager,
} from '../ssh/connection-manager.js';
import { sanitizeCommand } from '../ssh/command-utils.js';
import type { RuntimeOptions } from '../cli/args.js';

export interface ExecToolDependencies {
  getConnectionManager: () => Promise<SSHConnectionManager>;
  getRuntimeOptions: () => RuntimeOptions;
}

export function registerExecTool(server: McpServer, deps: ExecToolDependencies): void {
  server.tool(
    'exec',
    'Execute a shell command on the remote SSH server and return the output.',
    {
      command: z.string().describe('Shell command to execute on the remote SSH server'),
      description: z.string().optional().describe('Optional client-side command description; not sent to the remote shell'),
      timeoutMs: z.number()
        .int()
        .positive()
        .max(60 * 60 * 1000)
        .optional()
        .describe('Optional per-command timeout override in milliseconds'),
    },
    async ({ command, timeoutMs }) => {
      const runtime = deps.getRuntimeOptions();
      const sanitizedCommand = sanitizeCommand(command, runtime.maxChars);
      const effectiveTimeoutMs = timeoutMs ?? runtime.timeoutMs;
      try {
        const manager = await deps.getConnectionManager();
        await manager.ensureConnected();

        return await execSshCommandWithConnection(
          manager,
          sanitizedCommand,
          effectiveTimeoutMs,
          undefined,
          { useProfileSu: true },
        );
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InternalError, `Unexpected error: ${(err as Error)?.message ?? err}`);
      }
    },
  );
}

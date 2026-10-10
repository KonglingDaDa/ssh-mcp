import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  execSshCommandWithConnection,
  type SSHConnectionManager,
} from '../ssh/connection-manager.js';
import { sanitizeCommand, shellSingleQuote } from '../ssh/command-utils.js';
import type { RuntimeOptions } from '../cli/args.js';

export interface SudoExecToolDependencies {
  getConnectionManager: () => Promise<SSHConnectionManager>;
  getRuntimeOptions: () => RuntimeOptions;
}

export interface SudoCommandPlan {
  command: string;
  stdin?: string;
}

export function buildSudoCommand(command: string, sudoPassword?: string): SudoCommandPlan {
  if (!sudoPassword) {
    return { command: `sudo -n sh -c ${shellSingleQuote(command)}` };
  }
  return {
    command: `sudo -p "" -S sh -c ${shellSingleQuote(command)}`,
    stdin: `${sudoPassword}\n`,
  };
}

export function registerSudoExecTool(server: McpServer, deps: SudoExecToolDependencies): void {
  server.tool(
    'sudo-exec',
    'Execute a shell command on the remote SSH server using sudo. Will use sudo password if provided, otherwise assumes passwordless sudo.',
    {
      command: z.string().describe('Shell command to execute with sudo on the remote SSH server'),
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

        const sudoPlan = buildSudoCommand(sanitizedCommand, manager.getSudoPassword());
        return await execSshCommandWithConnection(
          manager,
          sudoPlan.command,
          effectiveTimeoutMs,
          sudoPlan.stdin,
          { useProfileSu: false },
        );
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InternalError, `Unexpected error: ${(err as Error)?.message ?? err}`);
      }
    },
  );
}

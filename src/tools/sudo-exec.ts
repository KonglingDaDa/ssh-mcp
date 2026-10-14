import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  execSshCommandWithConnection,
  type SSHConnectionManager,
} from '../ssh/connection-manager.js';
import { sanitizeCommand, shellSingleQuote } from '../ssh/command-utils.js';
import type { RuntimeOptions } from '../cli/args.js';
import type { ProfileDefinition } from '../config/types.js';
import { stampCommandResult } from './result.js';

export interface SudoExecToolDependencies {
  getConnectionContext: () => Promise<{
    manager: SSHConnectionManager;
    profile: ProfileDefinition;
  }>;
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
    'Runs the command with sudo on the current session active profile. There is no password parameter — uses the profile sudoPassword, or sudo -n if unset. This is only for sudo, not su. If the profile uses suPassword, exec is already elevated; call this only when you specifically need sudo. Do not put passwords in command. Same stamp rule as exec: read line 1 and stop on the wrong target.',
    {
      command: z.string().describe('Remote command body only; do not prefix with sudo and do not include the sudo password'),
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
        const { manager, profile } = await deps.getConnectionContext();
        await manager.ensureConnected();

        const sudoPlan = buildSudoCommand(sanitizedCommand, manager.getSudoPassword());
        const result = await execSshCommandWithConnection(
          manager,
          sudoPlan.command,
          effectiveTimeoutMs,
          sudoPlan.stdin,
          { useProfileSu: false },
        );
        return stampCommandResult(result, {
          id: profile.id,
          name: profile.name,
          host: profile.host,
          port: profile.port,
        });
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InternalError, `Unexpected error: ${(err as Error)?.message ?? err}`);
      }
    },
  );
}

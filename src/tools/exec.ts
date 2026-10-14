import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  execSshCommandWithConnection,
  type SSHConnectionManager,
} from '../ssh/connection-manager.js';
import { sanitizeCommand } from '../ssh/command-utils.js';
import type { RuntimeOptions } from '../cli/args.js';
import type { ProfileDefinition } from '../config/types.js';
import { stampCommandResult } from './result.js';

export interface ExecToolDependencies {
  getConnectionContext: () => Promise<{
    manager: SSHConnectionManager;
    profile: ProfileDefinition;
  }>;
  getRuntimeOptions: () => RuntimeOptions;
}

export function registerExecTool(server: McpServer, deps: ExecToolDependencies): void {
  server.tool(
    'exec',
    'Runs a shell command on the current session active profile only (no profileId argument). Call profiles-list first and stop if sessionActiveProfile is not the machine the user named. profiles-list returns the current target and bucket directory, not every machine. Success output line 1 is [ssh-mcp] target id=… name="…" host=…:port — if it is the wrong machine, stop. If this profile has suPassword, every exec is already elevated via su. description is client-side only and is not sent to the remote shell.',
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
        const { manager, profile } = await deps.getConnectionContext();
        await manager.ensureConnected();

        const result = await execSshCommandWithConnection(
          manager,
          sanitizedCommand,
          effectiveTimeoutMs,
          undefined,
          { useProfileSu: true },
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

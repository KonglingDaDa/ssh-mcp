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
import {
  stampCommandError,
  stampCommandResult,
  truncateCommandOutput,
} from './result.js';

export interface ExecToolDependencies {
  getConnectionContext: (expectedProfileId?: string) => Promise<{
    manager: SSHConnectionManager;
    profile: ProfileDefinition;
  }>;
  getRuntimeOptions: () => RuntimeOptions;
}

export function registerExecTool(server: McpServer, deps: ExecToolDependencies): void {
  server.tool(
    'exec',
    'Runs a shell command on the current session active profile. Optional profileId is a target guard: if provided and it does not match sessionActiveProfile, the call is rejected. Success output line 1 is [ssh-mcp] target id=… name="…" host=…:port — if it is the wrong machine, stop. If this profile has suPassword, every exec is already elevated via su. description is client-side only and is not sent to the remote shell.',
    {
      command: z.string().describe('Shell command to execute on the remote SSH server'),
      description: z.string().optional().describe('Optional client-side command description; not sent to the remote shell'),
      timeoutMs: z.number()
        .int()
        .positive()
        .max(60 * 60 * 1000)
        .optional()
        .describe('Optional per-command timeout override in milliseconds'),
      profileId: z.string().min(1).optional().describe('Optional expected target profile id guard. If provided and does not match sessionActiveProfile, execution is rejected to prevent cross-machine drift.'),
      maxOutputChars: z.number().int().positive().max(1000000).optional().describe('Optional maximum output characters to return (default 64000)'),
    },
    async ({ command, timeoutMs, profileId, maxOutputChars }) => {
      const runtime = deps.getRuntimeOptions();
      const sanitizedCommand = sanitizeCommand(command, runtime.maxChars);
      const effectiveTimeoutMs = timeoutMs ?? runtime.timeoutMs;
      let profile: ProfileDefinition | undefined;
      try {
        const context = await deps.getConnectionContext(profileId);
        profile = context.profile;
        await context.manager.ensureConnected();

        const result = await execSshCommandWithConnection(
          context.manager,
          sanitizedCommand,
          effectiveTimeoutMs,
          undefined,
          { useProfileSu: true },
        );
        const limited = {
          content: result.content.map((item) => ({
            ...item,
            text: truncateCommandOutput(item.text, maxOutputChars),
          })),
        };
        return stampCommandResult(limited, {
          id: profile.id,
          name: profile.name,
          host: profile.host,
          port: profile.port,
        });
      } catch (err: unknown) {
        if (err instanceof McpError && err.code === ErrorCode.InvalidParams) throw err;
        if (profile) {
          throw stampCommandError(err, {
            id: profile.id,
            name: profile.name,
            host: profile.host,
            port: profile.port,
          }, maxOutputChars);
        }
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InternalError, `Unexpected error: ${(err as Error)?.message ?? err}`);
      }
    },
  );
}

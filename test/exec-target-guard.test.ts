import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  execSshCommandWithConnection,
  type SSHConnectionManager,
} from '../src/ssh/connection-manager.js';
import type { RuntimeOptions } from '../src/cli/args.js';
import type { ProfileDefinition } from '../src/config/types.js';
import { registerExecTool } from '../src/tools/exec.js';
import { assertTargetProfile } from '../src/tools/result.js';
import { registerSudoExecTool } from '../src/tools/sudo-exec.js';

vi.mock('../src/ssh/connection-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ssh/connection-manager.js')>();
  return {
    ...actual,
    execSshCommandWithConnection: vi.fn(),
  };
});

const executeCommand = vi.mocked(execSshCommandWithConnection);

const activeProfile: ProfileDefinition = {
  id: 'no-pass',
  name: 'Local No Sudo Password',
  host: '127.0.0.1',
  port: 2222,
  user: 'test',
  auth: { type: 'password', password: 'secret' },
  aliases: [],
  note: '',
  tags: [],
};

const runtime: RuntimeOptions = {
  timeoutMs: 5000,
  maxChars: 10_000,
  disableSudo: false,
};

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
}>;

function makeFakeServer(): {
  server: McpServer;
  handlers: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      handler: ToolHandler,
    ) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

function makeManager(): SSHConnectionManager {
  return {
    ensureConnected: vi.fn(async () => undefined),
    getSudoPassword: vi.fn(() => undefined),
    getProfileId: vi.fn(() => activeProfile.id),
  } as unknown as SSHConnectionManager;
}

function registerTools(manager: SSHConnectionManager): Map<string, ToolHandler> {
  const { server, handlers } = makeFakeServer();
  const getConnectionContext = async (expectedProfileId?: string) => {
    assertTargetProfile(activeProfile, expectedProfileId);
    return { manager, profile: activeProfile };
  };
  registerExecTool(server, {
    getConnectionContext,
    getRuntimeOptions: () => runtime,
  });
  registerSudoExecTool(server, {
    getConnectionContext,
    getRuntimeOptions: () => runtime,
  });
  return handlers;
}

async function expectMcpError(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
    throw new Error('expected McpError');
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('exec target guard', () => {
  it('rejects exec and sudo-exec when profileId does not match and does not call executeCommand', async () => {
    const manager = makeManager();
    const handlers = registerTools(manager);

    const execErr = await expectMcpError(
      handlers.get('exec')!({ command: 'true', profileId: 'beta' }),
    );
    expect(execErr.code).toBe(ErrorCode.InvalidParams);
    expect(execErr.message).toContain(
      'Target profile mismatch: expected "beta", but sessionActiveProfile is "no-pass" (127.0.0.1:2222). Call profiles-use first or verify target.',
    );

    const sudoErr = await expectMcpError(
      handlers.get('sudo-exec')!({ command: 'true', profileId: 'beta' }),
    );
    expect(sudoErr.code).toBe(ErrorCode.InvalidParams);
    expect(sudoErr.message).toContain(
      'Target profile mismatch: expected "beta", but sessionActiveProfile is "no-pass" (127.0.0.1:2222). Call profiles-use first or verify target.',
    );

    expect(executeCommand).not.toHaveBeenCalled();
    expect(manager.ensureConnected).not.toHaveBeenCalled();
  });

  it('allows a matching profileId, calls the SSH layer, and stamps non-zero command errors', async () => {
    const manager = makeManager();
    const handlers = registerTools(manager);

    executeCommand.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'matched-guard\n' }],
    });

    const ok = await handlers.get('exec')!({
      command: 'echo matched-guard',
      profileId: 'no-pass',
    });
    const okText = ok.content[0]?.text ?? '';
    expect(okText).toContain(
      '[ssh-mcp] target id=no-pass name="Local No Sudo Password" host=127.0.0.1:2222',
    );
    expect(okText).toContain('matched-guard');
    expect(executeCommand).toHaveBeenCalledOnce();
    expect(manager.ensureConnected).toHaveBeenCalledOnce();

    executeCommand.mockRejectedValueOnce(
      new McpError(ErrorCode.InternalError, 'Error (code 7):\nboom-err'),
    );

    const failed = await expectMcpError(
      handlers.get('exec')!({
        command: 'sh -c "echo boom-err 1>&2; exit 7"',
        profileId: 'no-pass',
      }),
    );
    const stamp = '[ssh-mcp] target id=no-pass name="Local No Sudo Password" host=127.0.0.1:2222';
    expect(failed.message).toContain(stamp);
    expect(failed.message).toContain('boom-err');
    expect(failed.message.indexOf(stamp)).toBeLessThan(failed.message.indexOf('boom-err'));
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it('truncates oversized exec output using maxOutputChars and keeps head and tail', async () => {
    const manager = makeManager();
    const handlers = registerTools(manager);
    const remote = `AB${'q'.repeat(196)}YZ`;
    executeCommand.mockResolvedValueOnce({
      content: [{ type: 'text', text: remote }],
    });

    const res = await handlers.get('exec')!({
      command: 'printf oversized',
      profileId: 'no-pass',
      maxOutputChars: 100,
    });
    const text = res.content[0]?.text ?? '';
    const stamp = '[ssh-mcp] target id=no-pass name="Local No Sudo Password" host=127.0.0.1:2222\n';
    expect(text.startsWith(stamp)).toBe(true);
    const body = text.slice(stamp.length);
    expect(body).toHaveLength(100);
    expect(body.startsWith('AB')).toBe(true);
    expect(body.trimEnd().endsWith('YZ')).toBe(true);
    expect(body).toContain('...[ssh-mcp] output truncated (200 chars total, limit 100)...');
    expect(executeCommand).toHaveBeenCalledOnce();
  });
});

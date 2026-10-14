import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssh-mcp-target-guard-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function extractResponseText(response: any): string {
  if (response.error?.message) return String(response.error.message);
  return String(response.result?.content?.[0]?.text ?? '');
}

async function startServer(configPath: string, extraArgs: string[] = []): Promise<{
  callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;
  close: () => void;
}> {
  const serverPath = path.join(process.cwd(), 'build', 'index.js');
  const child = spawn('node', [serverPath, `--config=${configPath}`, '--timeout=5000', ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SSH_MCP_TEST: '1' },
  });

  let idCounter = 1;
  let buffer = '';
  const pending = new Map<number, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const pendingRequest = pending.get(message.id);
        if (pendingRequest) {
          pending.delete(message.id);
          pendingRequest.resolve(message);
        }
      } catch {
        // ignore non-json output
      }
    }
  });

  const call = (method: string, params: Record<string, unknown>) => {
    const id = idCounter++;
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`RPC timeout for ${method}`));
      }, 15000);
    });
  };

  await call('initialize', {
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
    protocolVersion: '0.1.0',
  });

  return {
    callTool: async (name, args = {}) =>
      call('tools/call', {
        name,
        arguments: args,
      }),
    close: () => {
      if (!child.killed) {
        child.kill();
      }
    },
  };
}

describe('exec target guard', () => {
  it('rejects exec and sudo-exec when profileId does not match the session target', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'profiles.yaml');
    await writeFile(configPath, `
version: 1
activeProfile: alpha
profiles:
  - id: alpha
    name: Alpha
    host: 127.0.0.1
    port: 1
    user: test
    auth:
      type: password
      password: "secret"
  - id: beta
    name: Beta
    host: 127.0.0.1
    port: 2
    user: test
    auth:
      type: password
      password: "secret"
`, 'utf8');

    const server = await startServer(configPath);
    try {
      const execRes = await server.callTool('exec', { command: 'true', profileId: 'beta' });
      const execText = extractResponseText(execRes);
      expect(execText).toContain('Target profile mismatch: expected "beta", but sessionActiveProfile is "alpha" (127.0.0.1:1). Call profiles-use first or verify target.');

      const sudoRes = await server.callTool('sudo-exec', { command: 'true', profileId: 'beta' });
      const sudoText = extractResponseText(sudoRes);
      expect(sudoText).toContain('Target profile mismatch: expected "beta", but sessionActiveProfile is "alpha" (127.0.0.1:1). Call profiles-use first or verify target.');
    } finally {
      server.close();
    }
  }, 45000);

  it('allows exec when profileId matches and stamps non-zero command errors', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'profiles.yaml');
    await writeFile(configPath, `
version: 1
activeProfile: no-pass
profiles:
  - id: no-pass
    name: Local No Sudo Password
    host: 127.0.0.1
    port: 2222
    user: test
    auth:
      type: password
      password: "secret"
  - id: other
    name: Other
    host: 127.0.0.1
    port: 2222
    user: test
    auth:
      type: password
      password: "secret"
`, 'utf8');

    const server = await startServer(configPath);
    try {
      const ok = await server.callTool('exec', { command: 'echo matched-guard', profileId: 'no-pass' });
      const okText = extractResponseText(ok);
      expect(okText).toContain('[ssh-mcp] target id=no-pass name="Local No Sudo Password" host=127.0.0.1:2222');
      expect(okText).toContain('matched-guard');

      const failed = await server.callTool('exec', { command: 'sh -c "echo boom-err 1>&2; exit 7"', profileId: 'no-pass' });
      const failedText = extractResponseText(failed);
      expect(failedText).toContain('[ssh-mcp] target id=no-pass name="Local No Sudo Password" host=127.0.0.1:2222');
      expect(failedText).toContain('boom-err');
    } finally {
      server.close();
    }
  }, 45000);

  it('truncates oversized exec output using maxOutputChars', async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, 'profiles.yaml');
    await writeFile(configPath, `
version: 1
activeProfile: no-pass
profiles:
  - id: no-pass
    name: Local No Sudo Password
    host: 127.0.0.1
    port: 2222
    user: test
    auth:
      type: password
      password: "secret"
`, 'utf8');

    const server = await startServer(configPath);
    try {
      const res = await server.callTool('exec', {
        command: "awk 'BEGIN{printf \"AB\"; for(i=0;i<196;i++) printf \"q\"; printf \"YZ\"}'",
        profileId: 'no-pass',
        maxOutputChars: 100,
      });
      const text = extractResponseText(res);
      const stamp = '[ssh-mcp] target id=no-pass name="Local No Sudo Password" host=127.0.0.1:2222\n';
      expect(text.startsWith(stamp)).toBe(true);
      const body = text.slice(stamp.length);
      expect(body).toHaveLength(100);
      expect(body.startsWith('AB')).toBe(true);
      expect(body.trimEnd().endsWith('YZ')).toBe(true);
      expect(body).toContain('...[ssh-mcp] output truncated (200 chars total, limit 100)...');
    } finally {
      server.close();
    }
  }, 45000);
});

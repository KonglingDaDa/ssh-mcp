import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Client, type ClientChannel } from 'ssh2';
import net from 'net';
import { DEFAULT_TIMEOUT_MS, shellSingleQuote } from './command-utils.js';

export interface SSHConfig {
  profileId?: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  suPassword?: string;
  sudoPassword?: string;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
  readyTimeout?: number;
}

export interface SshTestStepResult {
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface SshTestResult {
  target: string;
  attempts: number;
  tcp: SshTestStepResult;
  handshake: SshTestStepResult;
  auth: SshTestStepResult;
}

export interface SshTestOptions {
  timeoutMs?: number;
  retries?: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: string;
}

export interface PreparedSshCommand {
  command: string;
  stdinPrefix?: string;
}

export interface SshCommandExecutionOptions {
  useProfileSu?: boolean;
}

const DEFAULT_CONNECT_RETRY_DELAYS_MS = [200, 400];
const DEFAULT_TEST_TIMEOUT_MS = 10000;
const MAX_TEST_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAuthFailure(err: unknown): boolean {
  const message = toErrorMessage(err).toLowerCase();
  return message.includes('authentication') ||
    message.includes('permission denied') ||
    message.includes('all configured authentication methods failed') ||
    message.includes('auth failed');
}

function isRetryableConnectionError(err: unknown): boolean {
  if (isAuthFailure(err)) return false;
  const message = toErrorMessage(err).toLowerCase();
  const code = (err as { code?: string })?.code;
  if (code && ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code)) {
    return true;
  }
  return message.includes('handshake') ||
    message.includes('kex') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('connection closed') ||
    message.includes('protocol');
}

function formatCommandOutput(result: CommandResult): string {
  if (!result.stderr) return result.stdout;
  if (!result.stdout) return result.stderr;
  return `${result.stdout}${result.stdout.endsWith('\n') ? '' : '\n'}${result.stderr}`;
}

function formatCommandError(target: string, result: CommandResult): string {
  const status = result.signal
    ? `signal ${result.signal}`
    : `code ${result.code ?? 'unknown'}`;
  const output = formatCommandOutput(result);
  return `Error (${status}) (${target})${output ? `:\n${output}` : ''}`;
}

function watchClientLoss(conn: Client, onLost: (err: Error) => void): () => void {
  const onError = (err: Error) => onLost(err);
  const onClose = () => onLost(new Error('connection closed'));
  conn.on('error', onError);
  conn.on('close', onClose);
  return () => {
    conn.removeListener('error', onError);
    conn.removeListener('close', onClose);
  };
}

function abortCommandStream(stream: ClientChannel | null, conn: Client): void {
  if (stream) {
    try {
      stream.signal('TERM');
    } catch {
      // Some SSH servers do not support signal requests.
    }
    try {
      stream.close();
    } catch {
      // no-op
    }
  }
  try {
    conn.end();
  } catch {
    // no-op
  }
}

export function abandonLateChannel(
  isResolved: boolean,
  stream?: { close: () => void; signal?: (name: string) => void } | null,
): boolean {
  if (!isResolved) return false;
  if (stream) {
    try { stream.signal?.('TERM'); } catch { /* late channel after timeout */ }
    try { stream.close(); } catch { /* late channel after timeout */ }
  }
  return true;
}

function mergeStdin(stdinPrefix?: string, stdin?: string): string | undefined {
  if (!stdinPrefix) return stdin;
  if (!stdin) return stdinPrefix;
  return `${stdinPrefix}${stdin}`;
}

export function formatTargetContext(config: SSHConfig): string {
  const profileId = config.profileId ? config.profileId : 'unknown';
  return `profileId=${profileId} host=${config.host} port=${config.port}`;
}

export class SSHConnectionManager {
  private conn: Client | null = null;
  private sshConfig: SSHConfig;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;

  constructor(config: SSHConfig) {
    this.sshConfig = config;
  }

  async connect(): Promise<void> {
    if (this.conn && this.isConnected()) {
      return;
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    this.isConnecting = true;
    this.connectionPromise = this.connectWithRetry()
      .finally(() => {
        this.isConnecting = false;
        this.connectionPromise = null;
      });

    return this.connectionPromise;
  }

  private async connectWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= DEFAULT_CONNECT_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await this.connectOnce();
        return;
      } catch (err: unknown) {
        lastError = err;
        if (!isRetryableConnectionError(err) || attempt === DEFAULT_CONNECT_RETRY_DELAYS_MS.length) {
          throw this.wrapConnectionError(err);
        }
        await sleep(DEFAULT_CONNECT_RETRY_DELAYS_MS[attempt]);
      }
    }
    throw this.wrapConnectionError(lastError);
  }

  private getConnectConfig(): Omit<SSHConfig, 'profileId'> {
    const { profileId: _profileId, ...config } = this.sshConfig;
    return {
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      readyTimeout: 10000,
      ...config,
    };
  }

  private async connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      this.conn = client;

      const timeoutId = setTimeout(() => {
        client.end();
        if (this.conn === client) {
          this.conn = null;
        }
        const timeoutError = Object.assign(new Error('SSH connection timeout'), { code: 'ETIMEDOUT' });
        reject(timeoutError);
      }, 30000);

      client.on('ready', async () => {
        clearTimeout(timeoutId);
        resolve();
      });

      client.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        if (this.conn === client) {
          this.conn = null;
        }
        reject(err);
      });

      client.on('end', () => {
        if (this.conn === client) {
          this.conn = null;
        }
      });

      client.on('close', () => {
        if (this.conn === client) {
          this.conn = null;
        }
      });

      client.connect(this.getConnectConfig());
    });
  }

  private wrapConnectionError(err: unknown, targetOverride?: string): McpError {
    const target = targetOverride ?? this.getTargetContext();
    const message = toErrorMessage(err);
    return new McpError(ErrorCode.InternalError, `SSH connection error (${target}): ${message}`);
  }

  isConnected(): boolean {
    return this.conn !== null && Boolean((this.conn as any)._sock) && !(this.conn as any)._sock.destroyed;
  }

  getProfileId(): string | undefined {
    return this.sshConfig.profileId;
  }

  getSudoPassword(): string | undefined {
    return this.sshConfig.sudoPassword;
  }

  setSudoPassword(password?: string): void {
    this.sshConfig.sudoPassword = password;
  }

  getSuPassword(): string | undefined {
    return this.sshConfig.suPassword;
  }

  async setSuPassword(pwd?: string): Promise<void> {
    this.sshConfig.suPassword = pwd;
  }

  /**
   * Kept for compatibility with older callers. Commands are now elevated per
   * execution instead of through a shared interactive shell.
   */
  async ensureElevated(): Promise<void> {
    return;
  }

  async ensureConnected(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
  }

  getConnection(): Client {
    if (!this.conn) {
      throw new McpError(ErrorCode.InternalError, `SSH connection not established (${this.getTargetContext()})`);
    }
    return this.conn;
  }

  getTargetContext(): string {
    return formatTargetContext(this.sshConfig);
  }

  prepareExecutableCommand(command: string, options: SshCommandExecutionOptions = {}): PreparedSshCommand {
    const useProfileSu = options.useProfileSu ?? false;
    if (!useProfileSu || !this.sshConfig.suPassword) {
      return { command };
    }
    return {
      command: `su -c ${shellSingleQuote(command)}`,
      stdinPrefix: `${this.sshConfig.suPassword}\n`,
    };
  }

  close(expectedConn?: Client): void {
    if (expectedConn && this.conn !== expectedConn) {
      try {
        expectedConn.end();
      } catch {
        /* detached timed-out client; keep manager connection */
      }
      return;
    }
    if (!this.conn) return;
    this.conn.end();
    this.conn = null;
  }
}

export async function execSshCommandWithConnection(
  manager: SSHConnectionManager,
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stdin?: string,
  options: SshCommandExecutionOptions = {},
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
}> {
  return new Promise((resolve, reject) => {
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;
    const target = manager.getTargetContext();
    const conn = manager.getConnection();
    let streamRef: ClientChannel | null = null;
    const executableCommand = manager.prepareExecutableCommand(command, options);
    const stdinText = mergeStdin(executableCommand.stdinPrefix, stdin);

    let detachWatch = () => {};
    const finish = (settle: () => void) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutId);
      detachWatch();
      settle();
    };
    detachWatch = watchClientLoss(conn, (err) => {
      finish(() => {
        reject(new McpError(
          ErrorCode.InternalError,
          `SSH connection lost (${target}): ${err.message}`,
        ));
      });
    });

    timeoutId = setTimeout(() => {
      finish(() => {
        abortCommandStream(streamRef, conn);
        manager.close(conn);
        reject(new McpError(
          ErrorCode.InternalError,
          `Command execution timed out after ${timeoutMs}ms (${target})`,
        ));
      });
    }, timeoutMs);

    conn.exec(executableCommand.command, (err: Error | undefined, stream: ClientChannel) => {
      if (abandonLateChannel(isResolved, stream)) {
        return;
      }

      if (err) {
        finish(() => {
          manager.close(conn);
          reject(new McpError(ErrorCode.InternalError, `SSH exec error (${target}): ${err.message}`));
        });
        return;
      }

      streamRef = stream;
      let stdout = '';
      let stderr = '';

      if (stdinText && stdinText.length > 0) {
        try {
          stream.write(stdinText);
        } catch {
          // no-op
        }
      }
      try {
        stream.end();
      } catch {
        // no-op
      }

      stream.on('error', (streamErr: Error) => {
        finish(() => {
          manager.close(conn);
          reject(new McpError(
            ErrorCode.InternalError,
            `SSH channel error (${target}): ${streamErr.message}`,
          ));
        });
      });

      stream.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      stream.on('close', (code: number | null, signal?: string) => {
        finish(() => {
          const result = { stdout, stderr, code, signal };
          if (code !== 0 || signal) {
            reject(new McpError(ErrorCode.InternalError, formatCommandError(target, result)));
            return;
          }
          resolve({
            content: [{
              type: 'text',
              text: formatCommandOutput(result),
            }],
          });
        });
      });
    });
  });
}

export async function execSshCommand(
  sshConfig: SSHConfig,
  command: string,
  stdin?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: SshCommandExecutionOptions = {},
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;
    const target = formatTargetContext(sshConfig);
    let streamRef: ClientChannel | null = null;
    const manager = new SSHConnectionManager(sshConfig);
    const executableCommand = manager.prepareExecutableCommand(command, options);
    const stdinText = mergeStdin(executableCommand.stdinPrefix, stdin);

    timeoutId = setTimeout(() => {
      if (isResolved) return;
      isResolved = true;
      abortCommandStream(streamRef, conn);
      reject(new McpError(
        ErrorCode.InternalError,
        `Command execution timed out after ${timeoutMs}ms (${target})`,
      ));
    }, timeoutMs);

    conn.on('ready', () => {
      if (isResolved) {
        try {
          conn.end();
        } catch {
          // already timed out
        }
        return;
      }

      conn.exec(executableCommand.command, (err: Error | undefined, stream: ClientChannel) => {
        if (abandonLateChannel(isResolved, stream)) {
          return;
        }

        if (err) {
          isResolved = true;
          clearTimeout(timeoutId);
          reject(new McpError(ErrorCode.InternalError, `SSH exec error (${target}): ${err.message}`));
          conn.end();
          return;
        }

        streamRef = stream;
        if (stdinText && stdinText.length > 0) {
          try {
            stream.write(stdinText);
          } catch {
            // no-op
          }
        }
        try {
          stream.end();
        } catch {
          // no-op
        }

        let stdout = '';
        let stderr = '';
        stream.on('error', (streamErr: Error) => {
          if (isResolved) return;
          isResolved = true;
          clearTimeout(timeoutId);
          reject(new McpError(ErrorCode.InternalError, `SSH channel error (${target}): ${streamErr.message}`));
          try { conn.end(); } catch { /* already closed */ }
        });
        stream.on('close', (code: number | null, signal?: string) => {
          if (isResolved) return;
          isResolved = true;
          clearTimeout(timeoutId);
          conn.end();
          const result = { stdout, stderr, code, signal };
          if (code !== 0 || signal) {
            reject(new McpError(ErrorCode.InternalError, formatCommandError(target, result)));
            return;
          }
          resolve({
            content: [{
              type: 'text',
              text: formatCommandOutput(result),
            }],
          });
        });
        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });

    conn.on('error', (err: Error) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutId);
      reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
    });

    const { profileId: _profileId, ...connectConfig } = sshConfig;
    conn.connect(connectConfig);
  });
}

function normalizeRetries(retries?: number): number {
  if (retries === undefined || retries === null) return 2;
  if (!Number.isFinite(retries)) return 2;
  const value = Math.max(0, Math.min(MAX_TEST_RETRIES, Math.floor(retries)));
  return value;
}

async function testTcpConnection(host: string, port: number, timeoutMs: number): Promise<SshTestStepResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // no-op
      }
      resolve({
        ok,
        durationMs: Date.now() - start,
        ...(error ? { error } : {}),
      });
    };

    socket.setTimeout(timeoutMs, () => {
      finish(false, 'TCP connection timeout');
    });

    socket.once('error', (err) => {
      finish(false, err.message);
    });

    socket.once('connect', () => {
      finish(true);
    });
  });
}

async function testSshHandshakeAndAuth(
  sshConfig: SSHConfig,
  timeoutMs: number,
): Promise<{ handshake: SshTestStepResult; auth: SshTestStepResult; retryable: boolean }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const client = new Client();
    let settled = false;
    let handshakeOk = false;
    let authOk = false;
    let handshakeDuration = 0;
    let authDuration = 0;
    let errorMessage: string | undefined;
    let retryable = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        // no-op
      }
      resolve({
        handshake: {
          ok: handshakeOk,
          durationMs: handshakeDuration || Date.now() - start,
          ...(handshakeOk ? {} : { error: errorMessage ?? 'Handshake failed' }),
        },
        auth: {
          ok: authOk,
          durationMs: authDuration || Date.now() - start,
          ...(authOk ? {} : { error: errorMessage ?? 'Authentication failed' }),
        },
        retryable,
      });
    };

    const timeoutId = setTimeout(() => {
      errorMessage = 'SSH handshake timeout';
      retryable = true;
      finish();
    }, timeoutMs);

    client.on('banner', () => {
      if (!handshakeOk) {
        handshakeOk = true;
        handshakeDuration = Date.now() - start;
      }
    });

    client.on('ready', () => {
      clearTimeout(timeoutId);
      handshakeOk = true;
      authOk = true;
      if (!handshakeDuration) {
        handshakeDuration = Date.now() - start;
      }
      authDuration = Date.now() - start;
      finish();
    });

    const failClosed = (message: string) => {
      if (settled) return;
      clearTimeout(timeoutId);
      if (!errorMessage) errorMessage = message;
      retryable = false;
      finish();
    };
    client.once('close', () => {
      failClosed('SSH connection closed before handshake completed');
    });
    client.once('end', () => {
      failClosed('SSH connection closed before handshake completed');
    });

    client.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      errorMessage = err.message;
      const authFailure = isAuthFailure(err);
      if (authFailure) {
        handshakeOk = true;
        if (!handshakeDuration) {
          handshakeDuration = Date.now() - start;
        }
      }
      retryable = !authFailure && isRetryableConnectionError(err);
      finish();
    });

    const { profileId: _profileId, ...connectConfig } = sshConfig;
    client.connect(connectConfig);
  });
}

export async function testSshConnection(
  sshConfig: SSHConfig,
  options: SshTestOptions = {},
): Promise<SshTestResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const retries = normalizeRetries(options.retries);
  const target = formatTargetContext(sshConfig);

  const tcp = await testTcpConnection(sshConfig.host, sshConfig.port, timeoutMs);
  if (!tcp.ok) {
    return {
      target,
      attempts: 0,
      tcp,
      handshake: {
        ok: false,
        durationMs: 0,
        error: 'Skipped due to TCP failure',
      },
      auth: {
        ok: false,
        durationMs: 0,
        error: 'Skipped due to TCP failure',
      },
    };
  }

  let attempts = 0;
  let lastHandshake: SshTestStepResult = { ok: false, durationMs: 0, error: 'Not attempted' };
  let lastAuth: SshTestStepResult = { ok: false, durationMs: 0, error: 'Not attempted' };

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    attempts += 1;
    const result = await testSshHandshakeAndAuth(sshConfig, timeoutMs);
    lastHandshake = result.handshake;
    lastAuth = result.auth;
    if (lastAuth.ok) {
      return {
        target,
        attempts,
        tcp,
        handshake: lastHandshake,
        auth: lastAuth,
      };
    }
    if (!result.retryable || attempt === retries) {
      break;
    }
    const delayMs = Math.min(200 * (2 ** attempt), 2000);
    await sleep(delayMs);
  }

  return {
    target,
    attempts,
    tcp,
    handshake: lastHandshake,
    auth: lastAuth,
  };
}

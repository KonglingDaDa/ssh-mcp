import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_MAX_OUTPUT_CHARS = 64000;

export function asTextResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{
      type: 'text',
      text: `${JSON.stringify(payload, null, 2)}\n`,
    }],
  };
}

export interface TargetStamp {
  id: string;
  name: string;
  host: string;
  port: number;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

export function formatTargetStamp(target: TargetStamp): string {
  const name = singleLine(target.name).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const host = singleLine(target.host).replace(/\s/g, '');
  return `[ssh-mcp] target id=${target.id} name="${name}" host=${host}:${target.port}`;
}

export function stampCommandResult(
  result: { content: Array<{ type: 'text'; text: string }> },
  target: TargetStamp,
): { content: Array<{ type: 'text'; text: string }> } {
  const stamp = formatTargetStamp(target);
  const [first, ...rest] = result.content;
  if (!first) {
    return { content: [{ type: 'text', text: `${stamp}\n` }] };
  }
  return {
    content: [
      { type: 'text', text: `${stamp}\n${first.text}` },
      ...rest,
    ],
  };
}

export function truncateCommandOutput(text: string, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS): string {
  if (text.length <= maxOutputChars) return text;
  const marker = `\n...[ssh-mcp] output truncated (${text.length} chars total, limit ${maxOutputChars})...\n`;
  if (marker.length >= maxOutputChars) {
    return marker.slice(0, maxOutputChars);
  }
  const budget = maxOutputChars - marker.length;
  const headLen = Math.floor(budget * 0.7);
  const tailLen = budget - headLen;
  return `${text.slice(0, headLen)}${marker}${tailLen > 0 ? text.slice(-tailLen) : ''}`;
}

export function assertTargetProfile(
  active: { id: string; host: string; port: number },
  profileId?: string,
): void {
  if (!profileId) return;
  if (active.id === profileId) return;
  throw new McpError(
    ErrorCode.InvalidParams,
    `Target profile mismatch: expected "${profileId}", but sessionActiveProfile is "${active.id}" (${active.host}:${active.port}). Call profiles-use first or verify target.`,
  );
}

export function stampCommandError(
  err: unknown,
  target: TargetStamp,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
): McpError {
  const stamp = formatTargetStamp(target);
  if (err instanceof McpError) {
    if (err.message.startsWith('[ssh-mcp] target ')) {
      return err;
    }
    return new McpError(err.code, `${stamp}\n${truncateCommandOutput(err.message, maxOutputChars)}`);
  }
  const message = (err as Error)?.message ?? String(err);
  return new McpError(
    ErrorCode.InternalError,
    `${stamp}\nUnexpected error: ${truncateCommandOutput(message, maxOutputChars)}`,
  );
}


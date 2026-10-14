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


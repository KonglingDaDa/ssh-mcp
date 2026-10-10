import { describe, expect, it } from 'vitest';
import { SSHConnectionManager } from '../src/ssh/connection-manager';
import { buildSudoCommand } from '../src/tools/sudo-exec';

describe('SSH command planning', () => {
  it('passes suPassword through stdin instead of embedding it in command text', () => {
    const secret = "pa'ss;$(echo leaked)";
    const manager = new SSHConnectionManager({
      host: '127.0.0.1',
      port: 22,
      username: 'test',
      password: 'test',
      suPassword: secret,
    });

    const plan = manager.prepareExecutableCommand('whoami', { useProfileSu: true });

    expect(plan.command).toBe("su -c 'whoami'");
    expect(plan.command).not.toContain(secret);
    expect(plan.stdinPrefix).toBe(`${secret}\n`);
  });

  it('does not apply profile su wrapping unless explicitly requested', () => {
    const manager = new SSHConnectionManager({
      host: '127.0.0.1',
      port: 22,
      username: 'test',
      password: 'test',
      suPassword: 'secret',
    });

    const plan = manager.prepareExecutableCommand('whoami');

    expect(plan).toEqual({ command: 'whoami' });
  });

  it('passes sudoPassword through stdin instead of embedding it in command text', () => {
    const secret = "pa'ss;$(echo leaked)";
    const plan = buildSudoCommand('id', secret);

    expect(plan.command).toBe('sudo -p "" -S sh -c \'id\'');
    expect(plan.command).not.toContain(secret);
    expect(plan.stdin).toBe(`${secret}\n`);
  });

  it('uses non-interactive sudo when no sudoPassword is configured', () => {
    const plan = buildSudoCommand('id');

    expect(plan).toEqual({ command: "sudo -n sh -c 'id'" });
  });
});

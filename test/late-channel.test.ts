import { describe, it, expect, vi } from 'vitest';
import { abandonLateChannel, SSHConnectionManager } from '../src/ssh/connection-manager.js';
import type { Client } from 'ssh2';

describe('abandonLateChannel', () => {
  it('closes the stream when already resolved', () => {
    const stream = { close: vi.fn() };

    expect(abandonLateChannel(true, stream)).toBe(true);
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it('does not close the stream when not resolved', () => {
    const stream = { close: vi.fn() };

    expect(abandonLateChannel(false, stream)).toBe(false);
    expect(stream.close).not.toHaveBeenCalled();
  });

  it('returns true without a stream when already resolved', () => {
    expect(abandonLateChannel(true)).toBe(true);
    expect(abandonLateChannel(true, null)).toBe(true);
  });

  it('sends TERM before closing a late channel', () => {
    const stream = { close: vi.fn(), signal: vi.fn() };
    expect(abandonLateChannel(true, stream)).toBe(true);
    expect(stream.signal).toHaveBeenCalledWith('TERM');
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it('swallows close errors from a late channel', () => {
    const stream = {
      close: vi.fn(() => {
        throw new Error('already closed');
      }),
    };

    expect(abandonLateChannel(true, stream)).toBe(true);
    expect(stream.close).toHaveBeenCalledOnce();
  });
});

describe('SSHConnectionManager.close', () => {
  function makeManager(): SSHConnectionManager {
    return new SSHConnectionManager({
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      password: 'unused',
      profileId: 'test',
    });
  }

  it('ends only the mismatched timed-out client and keeps the live manager connection', () => {
    const manager = makeManager();
    const current = { end: vi.fn() } as unknown as Client;
    const other = { end: vi.fn() } as unknown as Client;
    (manager as unknown as { conn: Client | null }).conn = current;

    manager.close(other);

    expect(other.end).toHaveBeenCalledOnce();
    expect(current.end).not.toHaveBeenCalled();
    expect((manager as unknown as { conn: Client | null }).conn).toBe(current);
  });

  it('ends and clears the manager connection when closing the current client', () => {
    const manager = makeManager();
    const current = { end: vi.fn() } as unknown as Client;
    (manager as unknown as { conn: Client | null }).conn = current;

    manager.close(current);

    expect(current.end).toHaveBeenCalledOnce();
    expect((manager as unknown as { conn: Client | null }).conn).toBeNull();
  });

  it('swallows errors from ending a detached timed-out client', () => {
    const manager = makeManager();
    const current = { end: vi.fn() } as unknown as Client;
    const other = {
      end: vi.fn(() => {
        throw new Error('already gone');
      }),
    } as unknown as Client;
    (manager as unknown as { conn: Client | null }).conn = current;

    expect(() => manager.close(other)).not.toThrow();
    expect(other.end).toHaveBeenCalledOnce();
    expect(current.end).not.toHaveBeenCalled();
    expect((manager as unknown as { conn: Client | null }).conn).toBe(current);
  });
});

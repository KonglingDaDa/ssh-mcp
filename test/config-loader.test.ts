import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadProfilesConfig, profileSummary, saveRawProfilesConfig } from '../src/config/loader';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssh-mcp-config-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('config loader', () => {
  it('expands env vars and validates active profile', async () => {
    process.env.SSH_MCP_TEST_PASSWORD = 'secret';
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
defaults:
  timeout: 120000
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    port: 22
    user: root
    auth:
      type: password
      password: "\${SSH_MCP_TEST_PASSWORD}"
    note: "test"
`, 'utf8');

    const loaded = await loadProfilesConfig(filePath);
    expect(loaded.config.activeProfile).toBe('a');
    expect(loaded.config.profiles[0].auth.type).toBe('password');
    expect((loaded.config.profiles[0].auth as any).password).toBe('secret');
  });

  it('throws when env var is missing', async () => {
    delete process.env.SSH_MCP_MISSING_PASSWORD;
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "\${SSH_MCP_MISSING_PASSWORD}"
`, 'utf8');

    await expect(loadProfilesConfig(filePath)).rejects.toThrow('Missing required environment variable: SSH_MCP_MISSING_PASSWORD');
  });

  it('throws when active profile does not exist', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: missing
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "secret"
`, 'utf8');

    await expect(loadProfilesConfig(filePath)).rejects.toThrow('activeProfile "missing" does not exist in profiles');
  });

  it('does not expand env placeholders in note', async () => {
    process.env.SSH_MCP_TEST_PASSWORD = 'secret';
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "\${SSH_MCP_TEST_PASSWORD}"
    note: "leak \${SSH_MCP_TEST_PASSWORD}"
`, 'utf8');

    const loaded = await loadProfilesConfig(filePath);
    expect(loaded.config.profiles[0].note).toContain('${SSH_MCP_TEST_PASSWORD}');
    expect(loaded.config.profiles[0].note).not.toContain('secret');
    const summary = profileSummary(loaded.config.profiles[0], loaded.config.activeProfile);
    expect(summary.note).toContain('${SSH_MCP_TEST_PASSWORD}');
    expect(summary.elevatedViaSu).toBe(false);
  });

  it('marks elevatedViaSu when suPassword is set without exposing it', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "secret"
    suPassword: "su-secret"
`, 'utf8');

    const loaded = await loadProfilesConfig(filePath);
    const summary = profileSummary(loaded.config.profiles[0], 'a');
    expect(summary.elevatedViaSu).toBe(true);
    expect(summary).not.toHaveProperty('suPassword');
  });

  it('does not expand env placeholders in name or tags', async () => {
    process.env.SSH_MCP_TEST_PASSWORD = 'secret';
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: "Name \${SSH_MCP_TEST_PASSWORD}"
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "\${SSH_MCP_TEST_PASSWORD}"
    tags:
      - "tag \${SSH_MCP_TEST_PASSWORD}"
`, 'utf8');

    const loaded = await loadProfilesConfig(filePath);
    expect(loaded.config.profiles[0].name).toContain('${SSH_MCP_TEST_PASSWORD}');
    expect(loaded.config.profiles[0].name).not.toContain('secret');
    expect(loaded.config.profiles[0].tags).toEqual(['tag ${SSH_MCP_TEST_PASSWORD}']);
  });

  it('expands activeProfile env but keeps rawConfig unexpanded', async () => {
    process.env.SSH_MCP_ACTIVE_ID = 'a';
    process.env.SSH_MCP_TEST_PASSWORD = 'secret';
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: "\${SSH_MCP_ACTIVE_ID}"
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "\${SSH_MCP_TEST_PASSWORD}"
`, 'utf8');

    const loaded = await loadProfilesConfig(filePath);
    expect(loaded.config.activeProfile).toBe('a');
    expect(loaded.rawConfig.activeProfile).toBe('${SSH_MCP_ACTIVE_ID}');
  });

  it('throws when a secret field env var is missing', async () => {
    delete process.env.SSH_MCP_MISSING_SU_PASSWORD;
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "secret"
    suPassword: "\${SSH_MCP_MISSING_SU_PASSWORD}"
`, 'utf8');

    await expect(loadProfilesConfig(filePath)).rejects.toThrow('Missing required environment variable: SSH_MCP_MISSING_SU_PASSWORD');
  });

  it('loads a key profile even when keyPath does not exist yet',
    async () => {
      const dir = await makeTempDir();
      const filePath = path.join(dir, 'profiles.yaml');
      const missingKey = path.join(dir, 'missing-id_rsa');

      await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    user: root
    auth:
      type: key
      keyPath: ${JSON.stringify(missingKey)}
`, 'utf8');

      const loaded = await loadProfilesConfig(filePath);
      expect(loaded.config.profiles[0].auth.type).toBe('key');
      expect((loaded.config.profiles[0].auth as { keyPath: string }).keyPath).toBe(missingKey);
    });

  it('atomically saves config and preserves existing file mode', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: A
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "secret"
`, { encoding: 'utf8', mode: 0o640 });
    await chmod(filePath, 0o640);

    const loaded = await loadProfilesConfig(filePath);
    loaded.rawConfig.activeProfile = 'a';
    await saveRawProfilesConfig(loaded);

    const mode = (await stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o640);
    const reloaded = await loadProfilesConfig(filePath);
    expect(reloaded.config.activeProfile).toBe('a');
  });
});


import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, access } from 'fs/promises';
import os from 'os';
import path from 'path';
import { ProfileManager } from '../src/profile/profile-manager';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssh-mcp-profile-test-'));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

function envActivePlaceholderYaml(): string {
  return `
version: 1
activeProfile: \${ACTIVE_ID}
profiles:
  - id: alpha
    name: Alpha
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
  - id: beta
    name: Beta
    host: beta.example.com
    user: root
    auth:
      type: password
      password: "secret-beta"
  - id: gamma
    name: Gamma
    host: gamma.example.com
    user: root
    auth:
      type: password
      password: "secret-gamma"
`;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ProfileManager', () => {
  it('switches active profile and persists note updates', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: Alpha
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "secret-a"
    note: "note-a"
    tags: [a]
  - id: b
    name: Beta
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "secret-b"
    note: "note-b"
    tags: [b]
`, 'utf8');

    const manager = new ProfileManager(filePath);
    await manager.initialize();

    const listedBefore = manager.listProfiles();
    expect((listedBefore[0] as any).auth.password).toBe('***');
    expect(manager.getActiveProfileId()).toBe('a');

    await manager.setActiveProfile('b', true);
    expect(manager.getActiveProfileId()).toBe('b');
    expect(manager.getPersistedActiveProfileId()).toBe('b');

    await manager.updateNote('b', 'updated-note');
    const listedAfter = manager.listProfiles();
    const updated = listedAfter.find((item) => (item as any).id === 'b') as any;
    expect(updated.note).toBe('updated-note');

    const reloaded = new ProfileManager(filePath);
    await reloaded.initialize();
    const persisted = reloaded.listProfiles().find((item) => (item as any).id === 'b') as any;
    expect(persisted.note).toBe('updated-note');
    expect(reloaded.getActiveProfileId()).toBe('b');
  });

  it('session switch does not persist activeProfile', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: Alpha
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "secret-a"
  - id: b
    name: Beta
    host: 127.0.0.1
    user: root
    auth:
      type: password
      password: "secret-b"
`, 'utf8');

    const manager = new ProfileManager(filePath);
    await manager.initialize();

    await manager.setActiveProfile('b', false);
    expect(manager.getActiveProfileId()).toBe('b');
    expect(manager.getPersistedActiveProfileId()).toBe('a');

    const onDisk = await readFile(filePath, 'utf8');
    expect(onDisk).toContain('activeProfile: a');
    expect(onDisk).not.toMatch(/activeProfile:\s*b/);

    const reloaded = new ProfileManager(filePath);
    await reloaded.initialize();
    expect(reloaded.getActiveProfileId()).toBe('a');
  });

  it('creates, finds, prepares delete with backup, and confirms delete with explicit confirmation text', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: alpha
profiles:
  - id: alpha
    name: Alpha
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
    note: "alpha note"
    tags: [prod]
  - id: beta
    name: Beta
    host: beta.example.com
    user: root
    auth:
      type: password
      password: "secret-beta"
    note: "beta note"
    tags: [staging]
`, 'utf8');

    const manager = new ProfileManager(filePath);
    await manager.initialize();

    const created = await manager.createProfile({
      id: 'gamma',
      name: 'Gamma Relay',
      host: 'gamma.example.com',
      user: 'root',
      auth: { type: 'password', password: 'secret-gamma' },
      contextSummary: '用户说这是跳板机',
      tags: ['relay', 'jp'],
      activate: true,
    });
    expect((created as any).id).toBe('gamma');
    expect(manager.getActiveProfileId()).toBe('gamma');
    expect(manager.getPersistedActiveProfileId()).toBe('alpha');
    expect(await readFile(filePath, 'utf8')).toContain('activeProfile: alpha');

    const omittedActivate = await manager.createProfile({
      id: 'delta',
      name: 'Delta',
      host: 'delta.example.com',
      user: 'root',
      auth: { type: 'password', password: 'secret-delta' },
    });
    expect((omittedActivate as any).id).toBe('delta');
    expect(manager.getActiveProfileId()).toBe('gamma');
    expect(manager.getPersistedActiveProfileId()).toBe('alpha');

    const matched = manager.findProfiles('relay');
    expect(matched.length).toBeGreaterThan(0);
    expect((matched[0] as any).id).toBe('gamma');

    const prepared = await manager.prepareDeleteProfile('gamma');
    const deleteRequestId = (prepared as any).deleteRequestId as string;
    const backupPath = (prepared as any).backupPath as string;
    expect(deleteRequestId).toBeTruthy();
    expect(backupPath).toContain('.ssh-mcp-backups');
    await access(backupPath);

    await expect(
      manager.confirmDeleteProfile(deleteRequestId, 'gamma', 'DELETE alpha'),
    ).rejects.toThrow('Invalid confirmationText');

    const confirmed = await manager.confirmDeleteProfile(
      deleteRequestId,
      'gamma',
      'DELETE gamma',
    );
    expect((confirmed as any).deletedProfileId).toBe('gamma');

    const updatedConfig = await readFile(filePath, 'utf8');
    expect(updatedConfig).not.toContain('id: gamma');
    expect(updatedConfig).toContain('activeProfile:');
  });

  it('does not persist profile when create validation fails', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: alpha
profiles:
  - id: alpha
    name: Alpha
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
`, 'utf8');

    const manager = new ProfileManager(filePath);
    await manager.initialize();

    await expect(manager.createProfile({
      id: 'broken-key-profile',
      name: 'Broken Key',
      host: 'broken.example.com',
      user: 'root',
      auth: { type: 'key', keyPath: './keys/not-exists' },
      activate: true,
    })).rejects.toThrow('keyPath does not exist');

    const persistedConfig = await readFile(filePath, 'utf8');
    expect(persistedConfig).not.toContain('broken-key-profile');
    expect(persistedConfig).toContain('activeProfile: alpha');
  });

  it('rejects profile ids that are unsafe for CLI and confirmation workflows', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: alpha
profiles:
  - id: alpha
    name: Alpha
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
  - id: ../danger/path
    name: Danger
    host: danger.example.com
    user: root
    auth:
      type: password
      password: "secret-danger"
`, 'utf8');

    const manager = new ProfileManager(filePath);
    await expect(manager.initialize()).rejects.toThrow('profile id must use only letters');
  });

  it('deleting unrelated profile does not rewrite persisted active profile from startup override', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');

    await writeFile(filePath, `
version: 1
activeProfile: alpha
profiles:
  - id: alpha
    name: Alpha
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
  - id: beta
    name: Beta
    host: beta.example.com
    user: root
    auth:
      type: password
      password: "secret-beta"
  - id: gamma
    name: Gamma
    host: gamma.example.com
    user: root
    auth:
      type: password
      password: "secret-gamma"
`, 'utf8');

    const manager = new ProfileManager(filePath, 'beta');
    await manager.initialize();
    expect(manager.getActiveProfileId()).toBe('beta');

    const prepared = await manager.prepareDeleteProfile('gamma');
    const requestId = (prepared as any).deleteRequestId as string;
    await manager.confirmDeleteProfile(requestId, 'gamma', 'DELETE gamma');

    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).toContain('activeProfile: alpha');
    expect(persisted).not.toContain('id: gamma');
    expect(manager.getActiveProfileId()).toBe('beta');
  });

  it('refuses to start when the startup profile override does not exist', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');
    await writeFile(filePath, `
version: 1
activeProfile: alpha
profiles:
  - id: alpha
    name: Alpha
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
`, 'utf8');

    const manager = new ProfileManager(filePath, 'missing-host');
    await expect(manager.initialize()).rejects.toThrow('Startup profile override "missing-host" not found');
  });

  it('returns to the startup pin after deleting the session target', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');
    await writeFile(filePath, `
version: 1
activeProfile: alpha
profiles:
  - id: alpha
    name: Alpha
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
  - id: beta
    name: Beta
    host: beta.example.com
    user: root
    auth:
      type: password
      password: "secret-beta"
  - id: gamma
    name: Gamma
    host: gamma.example.com
    user: root
    auth:
      type: password
      password: "secret-gamma"
`, 'utf8');

    const manager = new ProfileManager(filePath, 'beta');
    await manager.initialize();
    manager.useProfile('gamma');
    const prepared = await manager.prepareDeleteProfile('gamma');
    const requestId = (prepared as any).deleteRequestId as string;
    const deleted = await manager.confirmDeleteProfile(requestId, 'gamma', 'DELETE gamma');

    expect(deleted.activeProfile).toBe('beta');
    expect(manager.getActiveProfileId()).toBe('beta');
    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).toContain('activeProfile: alpha');
    expect(persisted).not.toContain('id: gamma');
  });

  it('keeps unexpanded ${ACTIVE_ID} when deleting a non-default profile', async () => {
    const previousActiveId = process.env.ACTIVE_ID;
    process.env.ACTIVE_ID = 'beta';

    try {
      const dir = await makeTempDir();
      const filePath = path.join(dir, 'profiles.yaml');
      await writeFile(filePath, envActivePlaceholderYaml(), 'utf8');

      const manager = new ProfileManager(filePath);
      await manager.initialize();
      expect(manager.getActiveProfileId()).toBe('beta');

      const prepared = await manager.prepareDeleteProfile('gamma');
      const requestId = (prepared as any).deleteRequestId as string;
      await manager.confirmDeleteProfile(requestId, 'gamma', 'DELETE gamma');

      const persisted = await readFile(filePath, 'utf8');
      expect(persisted).toMatch(/activeProfile:\s*'?\$\{ACTIVE_ID\}'?/);
      expect(persisted).not.toMatch(/activeProfile:\s*'?alpha'?/);
      expect(persisted).not.toContain('id: gamma');
      expect(manager.getActiveProfileId()).toBe('beta');

      await manager.reload();
      expect(manager.getActiveProfileId()).toBe('beta');

      const reloaded = new ProfileManager(filePath);
      await reloaded.initialize();
      expect(reloaded.getActiveProfileId()).toBe('beta');
    } finally {
      restoreEnv('ACTIVE_ID', previousActiveId);
    }
  });

  it('rewrites file default to first remaining id when deleting expanded ${ACTIVE_ID} target', async () => {
    const previousActiveId = process.env.ACTIVE_ID;
    process.env.ACTIVE_ID = 'beta';

    try {
      const dir = await makeTempDir();
      const filePath = path.join(dir, 'profiles.yaml');
      await writeFile(filePath, envActivePlaceholderYaml(), 'utf8');

      const manager = new ProfileManager(filePath);
      await manager.initialize();
      expect(manager.getActiveProfileId()).toBe('beta');

      const prepared = await manager.prepareDeleteProfile('beta');
      const requestId = (prepared as any).deleteRequestId as string;
      await manager.confirmDeleteProfile(requestId, 'beta', 'DELETE beta');

      const persisted = await readFile(filePath, 'utf8');
      expect(persisted).toMatch(/activeProfile:\s*'?alpha'?/);
      expect(persisted).not.toContain('${ACTIVE_ID}');
      expect(persisted).not.toContain('id: beta');
      expect(manager.getActiveProfileId()).toBe('alpha');

      const reloaded = new ProfileManager(filePath);
      await reloaded.initialize();
      expect(reloaded.getActiveProfileId()).toBe('alpha');
    } finally {
      restoreEnv('ACTIVE_ID', previousActiveId);
    }
  });
});

describe('profile directory search', () => {
  const yaml = `
version: 1
activeProfile: alpha
buckets:
  - id: production
    name: 生产端
    aliases: [生产, prod]
  - id: customer
    name: 客户服务器
    aliases: [客户]
profiles:
  - id: alpha
    name: 生产机
    aliases: [Prod Box]
    host: alpha.example.com
    user: root
    auth:
      type: password
      password: "secret-alpha"
    note: "现网生产"
    tags: [production, us]
  - id: beta
    name: 客户机
    host: beta.example.com
    user: ubuntu
    auth:
      type: password
      password: "secret-beta"
    note: "客户环境"
    tags: [客户]
  - id: gamma
    name: 未分组
    host: gamma.example.com
    user: root
    auth:
      type: password
      password: "secret-gamma"
    tags: [a13]
`;

  async function loadManager(): Promise<ProfileManager> {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');
    await writeFile(filePath, yaml, 'utf8');
    const manager = new ProfileManager(filePath);
    await manager.initialize();
    return manager;
  }

  it('loads an old file without buckets or aliases', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');
    await writeFile(filePath, `
version: 1
activeProfile: a
profiles:
  - id: a
    name: A
    host: a.example.com
    user: root
    auth:
      type: password
      password: "secret-a"
`, 'utf8');
    const manager = new ProfileManager(filePath);
    await manager.initialize();
    const view = manager.directoryView();
    expect(view.buckets).toEqual([]);
    expect(view.unbucketedCount).toBe(1);
    expect(JSON.stringify(view)).not.toContain('secret-a');
  });

  it('lists bucket counts without other machines', async () => {
    const manager = await loadManager();
    const view = manager.directoryView();
    const text = JSON.stringify(view);
    expect(text).not.toContain('beta.example.com');
    expect(text).not.toContain('secret-alpha');
    expect(view.profileCount).toBe(3);
    expect(view.unbucketedCount).toBe(1);
    const buckets = view.buckets as Array<{ id: string; count: number }>;
    expect(buckets.find((item) => item.id === 'production')?.count).toBe(1);
    expect(buckets.find((item) => item.id === 'customer')?.count).toBe(1);
    expect((view.activeProfileSummary as { host: string }).host).toBe('alpha.example.com');
  });

  it('omits keyPath and passwords from directory and search views', async () => {
    const dir = await makeTempDir();
    const keyPath = path.join(dir, 'id_rsa');
    await writeFile(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n', 'utf8');
    const filePath = path.join(dir, 'profiles.yaml');
    await writeFile(filePath, `
version: 1
activeProfile: keybox
buckets:
  - id: vps
    name: VPS
profiles:
  - id: keybox
    name: Key Box
    host: key.example.com
    user: root
    auth:
      type: key
      keyPath: ${JSON.stringify(keyPath)}
    tags: [vps]
  - id: passbox
    name: Pass Box
    host: pass.example.com
    user: root
    auth:
      type: password
      password: "secret-pass"
    tags: [vps]
`, 'utf8');
    const manager = new ProfileManager(filePath);
    await manager.initialize();

    const viewText = JSON.stringify(manager.directoryView());
    expect(viewText).not.toContain(keyPath);
    expect(viewText).not.toContain('keyPath');
    expect(viewText).not.toContain('secret-pass');
    expect((manager.directoryView().activeProfileSummary as { auth: { type: string } }).auth).toEqual({ type: 'key' });

    const found = manager.searchProfiles({ bucket: 'vps' });
    const foundText = JSON.stringify(found);
    expect(found.matches).toHaveLength(2);
    expect(found.matches.map((item) => item.auth.type).sort()).toEqual(['key', 'password']);
    expect(foundText).not.toContain(keyPath);
    expect(foundText).not.toContain('keyPath');
    expect(foundText).not.toContain('secret-pass');
  });

  it('rejects an empty search instead of returning every profile', async () => {
    const manager = await loadManager();
    expect(() => manager.searchProfiles({})).toThrow(/bucket or query is required/);
  });

  it('opens a bucket by Chinese alias and can filter inside it', async () => {
    const manager = await loadManager();
    const opened = manager.searchProfiles({ bucket: '生产' });
    expect(opened.matches.map((item) => item.id)).toEqual(['alpha']);
    expect(opened.matches[0].auth).toEqual({ type: 'password' });
    expect(JSON.stringify(opened)).not.toContain('secret-alpha');
    expect(JSON.stringify(opened)).not.toContain('beta.example.com');

    const filtered = manager.searchProfiles({ bucket: 'production', query: 'missing' });
    expect(filtered.matches).toEqual([]);
  });

  it('finds a machine by Chinese or English alias without dumping the catalog', async () => {
    const manager = await loadManager();
    const byAlias = manager.searchProfiles({ query: 'Prod Box' });
    expect(byAlias.matches.map((item) => item.id)).toEqual(['alpha']);
    expect(byAlias.truncated).toBe(false);

    const byTag = manager.searchProfiles({ bucket: 'a13' });
    expect(byTag.tag).toBe('a13');
    expect(byTag.matches.map((item) => item.id)).toEqual(['gamma']);
  });

  it('caps keyword hits and reports truncation', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');
    const profiles = Array.from({ length: 9 }, (_, index) => `
  - id: box${index}
    name: Box ${index}
    host: box${index}.example.com
    user: root
    auth:
      type: password
      password: "secret"
    tags: [shared]
`).join('');
    await writeFile(filePath, `
version: 1
activeProfile: box0
profiles:${profiles}
`, 'utf8');
    const manager = new ProfileManager(filePath);
    await manager.initialize();
    const found = manager.searchProfiles({ query: 'shared' });
    expect(found.matches).toHaveLength(8);
    expect(found.total).toBe(9);
    expect(found.truncated).toBe(true);
  });

  it('caps opened directory buckets at 30 and reports truncation', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');
    const profiles = Array.from({ length: 31 }, (_, index) => `
  - id: gpu${index}
    name: GPU ${index}
    host: gpu${index}.example.com
    user: root
    auth:
      type: password
      password: "secret"
    tags: [gpu-pool]
`).join('');
    await writeFile(filePath, `
version: 1
activeProfile: gpu0
buckets:
  - id: gpu-pool
    name: 显卡机
    aliases: [显卡]
profiles:${profiles}
`, 'utf8');
    const manager = new ProfileManager(filePath);
    await manager.initialize();
    const opened = manager.searchProfiles({ bucket: '显卡' });
    expect(opened.bucket).toEqual({ id: 'gpu-pool', name: '显卡机' });
    expect(opened.matches).toHaveLength(30);
    expect(opened.total).toBe(31);
    expect(opened.truncated).toBe(true);
  });

  it('caps raw tag matches at 12 and reports truncation', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');
    const profiles = Array.from({ length: 13 }, (_, index) => `
  - id: node${index}
    name: Node ${index}
    host: node${index}.example.com
    user: root
    auth:
      type: password
      password: "secret"
    tags: [edge]
`).join('');
    await writeFile(filePath, `
version: 1
activeProfile: node0
buckets:
  - id: production
    name: 生产端
profiles:${profiles}
`, 'utf8');
    const manager = new ProfileManager(filePath);
    await manager.initialize();
    const found = manager.searchProfiles({ bucket: 'edge' });
    expect(found.bucket).toBeNull();
    expect(found.tag).toBe('edge');
    expect(found.matches).toHaveLength(12);
    expect(found.total).toBe(13);
    expect(found.truncated).toBe(true);
  });

  it('persists bucket and label updates without rewriting auth', async () => {
    const manager = await loadManager();
    await manager.upsertBucket({
      id: 'vps',
      name: '自己的 VPS',
      aliases: ['vps', '自己的'],
    });
    const labeled = await manager.updateProfileLabels('gamma', {
      name: '边缘节点01',
      aliases: ['EdgeNode', '边缘'],
      note: '美国 VPS，端口会变',
      addTags: ['vps'],
    });
    expect(labeled.name).toBe('边缘节点01');
    expect(labeled.aliases).toEqual(['EdgeNode', '边缘']);
    expect(labeled.note).toBe('美国 VPS，端口会变');

    const reloaded = new ProfileManager(manager.getConfigPath());
    await reloaded.initialize();
    const opened = reloaded.searchProfiles({ bucket: '自己的' });
    expect(opened.matches.map((item) => item.id)).toEqual(['gamma']);
    const onDisk = await readFile(manager.getConfigPath(), 'utf8');
    expect(onDisk).toContain('secret-gamma');
    expect(onDisk).toContain('自己的 VPS');
  });

  it('rejects an ambiguous bucket name', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'profiles.yaml');
    await writeFile(filePath, `
version: 1
activeProfile: a
buckets:
  - id: corenet
    name: 核心网
  - id: relay
    name: 中转网
profiles:
  - id: a
    name: A
    host: a.example.com
    user: root
    auth:
      type: password
      password: "secret"
    tags: [corenet]
`, 'utf8');
    const manager = new ProfileManager(filePath);
    await manager.initialize();
    expect(() => manager.searchProfiles({ bucket: '网' })).toThrow(/Ambiguous bucket/);
  });
});

import {
  loadProfilesConfig,
  profileSummary,
  saveRawProfilesConfig,
  validateRawProfilesConfig,
} from '../config/loader.js';
import { type BucketDefinition, type LoadedProfilesConfig, type ProfileDefinition, profileSchema } from '../config/types.js';
import {
  buildDirectory,
  searchCatalog,
  toSearchCard,
  type CatalogProfile,
  type CatalogSearchResult,
  type SearchCard,
} from './profile-catalog.js';
import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

function hasProfile(profiles: ProfileDefinition[], profileId: string): boolean {
  return profiles.some((profile) => profile.id === profileId);
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
}

function cloneRawConfig(rawConfig: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(rawConfig);
}

function sanitizeBackupReason(reason: string): string {
  const sanitized = reason
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (sanitized.length === 0) return 'backup';
  return sanitized.slice(0, 80);
}

function readPersistedActiveProfileId(
  rawConfig: Record<string, unknown>,
  fallback: string,
): string {
  const rawActive = rawConfig.activeProfile;
  if (typeof rawActive === 'string' && rawActive.trim().length > 0) {
    return rawActive;
  }
  return fallback;
}

function toShortNote(input: string): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 117)}...`;
}

export interface ProfileCreateInput {
  id: string;
  name: string;
  host: string;
  port?: number;
  user: string;
  auth:
    | { type: 'password'; password: string }
    | { type: 'key'; keyPath: string };
  suPassword?: string;
  sudoPassword?: string;
  note?: string;
  aliases?: string[];
  tags?: string[];
  contextSummary?: string;
  activate?: boolean;
}

export interface ProfileLabelUpdate {
  name?: string;
  aliases?: string[];
  note?: string;
  addTags?: string[];
  removeTags?: string[];
}

export interface BucketUpsertInput {
  id: string;
  name?: string;
  aliases?: string[];
  note?: string;
  remove?: boolean;
}

interface PendingDeleteRequest {
  requestId: string;
  profileId: string;
  backupPath: string;
  createdAt: number;
  expiresAt: number;
}

function defaultNoteForProfile(input: ProfileCreateInput): string {
  if (input.note && input.note.trim().length > 0) {
    return input.note.trim();
  }

  const hints: string[] = [];
  if (input.contextSummary && input.contextSummary.trim().length > 0) {
    hints.push(input.contextSummary.trim());
  }
  if (input.tags && input.tags.length > 0) {
    hints.push(`tags:${input.tags.join(',')}`);
  }
  hints.push(`${input.name}(${input.host})`);
  return toShortNote(hints.join(' | '));
}

export class ProfileManager {
  private loadedConfig: LoadedProfilesConfig | null = null;
  private activeProfileId: string | null = null;
  private readonly profileOverride?: string;
  private readonly configPath: string;
  private readonly pendingDeletes = new Map<string, PendingDeleteRequest>();

  constructor(configPath: string, profileOverride?: string) {
    this.configPath = configPath;
    this.profileOverride = profileOverride;
  }

  async initialize(): Promise<void> {
    const loaded = await loadProfilesConfig(this.configPath);
    if (this.profileOverride && !hasProfile(loaded.config.profiles, this.profileOverride)) {
      throw new Error(`Startup profile override "${this.profileOverride}" not found in profiles`);
    }
    this.loadedConfig = loaded;
    this.activeProfileId = this.pickActiveProfileId(loaded, this.profileOverride);
  }

  private ensureLoaded(): LoadedProfilesConfig {
    if (!this.loadedConfig || !this.activeProfileId) {
      throw new Error('ProfileManager is not initialized');
    }
    return this.loadedConfig;
  }

  private pickActiveProfileId(loaded: LoadedProfilesConfig, preferred?: string): string {
    const candidates = [preferred, this.profileOverride, loaded.config.activeProfile];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (hasProfile(loaded.config.profiles, candidate)) {
        return candidate;
      }
    }
    throw new Error('Unable to resolve an active profile from configuration');
  }

  private getRawProfiles(rawConfig: Record<string, unknown>): Record<string, unknown>[] {
    const rawProfiles = rawConfig.profiles;
    if (!Array.isArray(rawProfiles)) {
      throw new Error('Invalid raw config: profiles is not an array');
    }
    for (const item of rawProfiles) {
      assertObject(item, 'Invalid raw profile item');
    }
    return rawProfiles as Record<string, unknown>[];
  }

  private findRawProfile(rawConfig: Record<string, unknown>, profileId: string): Record<string, unknown> | undefined {
    const rawProfiles = this.getRawProfiles(rawConfig);
    return rawProfiles.find((item) => item.id === profileId);
  }

  private async persistRawConfig(rawConfig: Record<string, unknown>, preferredActiveId?: string): Promise<void> {
    const currentLoaded = this.ensureLoaded();
    const parsedConfig = await validateRawProfilesConfig(rawConfig, this.configPath);
    const nextLoaded: LoadedProfilesConfig = {
      ...currentLoaded,
      rawConfig,
      config: parsedConfig,
    };

    await saveRawProfilesConfig(nextLoaded);
    this.loadedConfig = nextLoaded;
    this.activeProfileId = this.pickActiveProfileId(
      nextLoaded,
      preferredActiveId ?? this.activeProfileId ?? undefined,
    );
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getActiveProfileId(): string {
    this.ensureLoaded();
    return this.activeProfileId as string;
  }

  getPersistedActiveProfileId(): string {
    const loaded = this.ensureLoaded();
    return readPersistedActiveProfileId(loaded.rawConfig, loaded.config.activeProfile);
  }

  getActiveProfile(): ProfileDefinition {
    const loaded = this.ensureLoaded();
    const activeId = this.activeProfileId as string;
    const profile = loaded.config.profiles.find((item) => item.id === activeId);
    if (!profile) {
      throw new Error(`Active profile "${activeId}" not found`);
    }
    return profile;
  }

  getProfileById(profileId: string): ProfileDefinition {
    return this.getProfile(profileId);
  }

  getDefaults(): LoadedProfilesConfig['config']['defaults'] {
    const loaded = this.ensureLoaded();
    return loaded.config.defaults ?? {};
  }

  getStartupProfileOverride(): string | undefined {
    return this.profileOverride;
  }

  getTargetView(): Record<string, unknown> {
    return {
      activeProfile: this.getActiveProfileId(),
      sessionActiveProfile: this.getActiveProfileId(),
      fileActiveProfile: this.getPersistedActiveProfileId(),
      startupProfileOverride: this.profileOverride ?? null,
    };
  }

  listProfiles(): Record<string, unknown>[] {
    const loaded = this.ensureLoaded();
    const activeId = this.activeProfileId as string;
    return loaded.config.profiles.map((profile) => profileSummary(profile, activeId));
  }

  private catalogBuckets(): BucketDefinition[] {
    return this.ensureLoaded().config.buckets ?? [];
  }

  private catalogProfiles(): CatalogProfile[] {
    const loaded = this.ensureLoaded();
    const activeId = this.getActiveProfileId();
    return loaded.config.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      aliases: profile.aliases ?? [],
      host: profile.host,
      port: profile.port,
      user: profile.user,
      note: profile.note ?? '',
      tags: profile.tags ?? [],
      authType: profile.auth.type,
      elevatedViaSu: Boolean(profile.suPassword),
      active: profile.id === activeId,
    }));
  }

  directoryView(): Record<string, unknown> {
    const profiles = this.catalogProfiles();
    const buckets = this.catalogBuckets();
    const active = profiles.find((profile) => profile.active) ?? null;
    return {
      ...this.getTargetView(),
      profileCount: profiles.length,
      activeProfileSummary: active ? toSearchCard(active, buckets) : null,
      ...buildDirectory(profiles, buckets),
      hint: 'Bucket directory only. Call profiles-find with bucket or query to see machines.',
    };
  }

  useProfile(profileId: string): Record<string, unknown> {
    const loaded = this.ensureLoaded();
    const profile = loaded.config.profiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new Error(`Profile "${profileId}" does not exist`);
    }
    this.activeProfileId = profileId;
    return profileSummary(profile, profileId);
  }

  async setActiveProfile(profileId: string, persist = true): Promise<Record<string, unknown>> {
    const profile = this.getProfile(profileId);
    if (persist) {
      const loaded = this.ensureLoaded();
      const nextRawConfig = cloneRawConfig(loaded.rawConfig);
      nextRawConfig.activeProfile = profileId;
      await this.persistRawConfig(nextRawConfig, profileId);
    } else {
      this.activeProfileId = profileId;
    }
    return profileSummary(profile, this.getActiveProfileId());
  }

  findProfiles(query: string): SearchCard[] {
    return this.searchProfiles({ query }).matches;
  }

  searchProfiles(input: { query?: string; bucket?: string }): CatalogSearchResult & Record<string, unknown> {
    const result = searchCatalog(this.catalogProfiles(), this.catalogBuckets(), input);
    return {
      ...this.getTargetView(),
      ...result,
    };
  }

  async reload(): Promise<Record<string, unknown>> {
    const loaded = await loadProfilesConfig(this.configPath);
    this.loadedConfig = loaded;
    this.activeProfileId = this.pickActiveProfileId(loaded);

    return {
      configPath: this.configPath,
      ...this.directoryView(),
    };
  }

  async updateNote(profileId: string, note: string): Promise<Record<string, unknown>> {
    this.getProfile(profileId);
    const loaded = this.ensureLoaded();
    const nextRawConfig = cloneRawConfig(loaded.rawConfig);
    const rawProfile = this.findRawProfile(nextRawConfig, profileId);
    if (!rawProfile) {
      throw new Error(`Raw config profile "${profileId}" not found`);
    }

    rawProfile.note = note;
    await this.persistRawConfig(nextRawConfig);
    return profileSummary(this.getProfile(profileId), this.getActiveProfileId());
  }

  async createProfile(input: ProfileCreateInput): Promise<Record<string, unknown>> {
    const loaded = this.ensureLoaded();
    if (this.getProfileMaybe(input.id)) {
      throw new Error(`Profile "${input.id}" already exists`);
    }

    const parsed = profileSchema.parse({
      id: input.id,
      name: input.name,
      aliases: input.aliases ?? [],
      host: input.host,
      port: input.port ?? 22,
      user: input.user,
      auth: input.auth,
      suPassword: input.suPassword,
      sudoPassword: input.sudoPassword,
      note: defaultNoteForProfile(input),
      tags: input.tags ?? [],
    });

    const nextRawConfig = cloneRawConfig(loaded.rawConfig);
    const rawProfiles = this.getRawProfiles(nextRawConfig);
    const rawProfile: Record<string, unknown> = {
      id: input.id,
      name: input.name,
      host: input.host,
      port: input.port ?? 22,
      user: input.user,
      auth: input.auth.type === 'password'
        ? { type: 'password', password: input.auth.password }
        : { type: 'key', keyPath: input.auth.keyPath },
      note: parsed.note,
      tags: input.tags ?? [],
    };
    if (parsed.aliases.length > 0) rawProfile.aliases = parsed.aliases;

    if (input.suPassword) rawProfile.suPassword = input.suPassword;
    if (input.sudoPassword) rawProfile.sudoPassword = input.sudoPassword;
    rawProfiles.push(rawProfile);

    const shouldActivate = input.activate === true;
    await this.persistRawConfig(nextRawConfig, this.activeProfileId ?? undefined);
    if (shouldActivate) {
      this.activeProfileId = input.id;
    }
    return profileSummary(this.getProfile(input.id), this.getActiveProfileId());
  }

  async upsertBucket(input: BucketUpsertInput): Promise<Record<string, unknown>> {
    const loaded = this.ensureLoaded();
    const nextRawConfig = cloneRawConfig(loaded.rawConfig);
    const buckets = Array.isArray(nextRawConfig.buckets)
      ? nextRawConfig.buckets as Record<string, unknown>[]
      : [];
    const index = buckets.findIndex((item) => item.id === input.id);

    if (input.remove) {
      if (index < 0) {
        throw new Error(`Bucket "${input.id}" not found`);
      }
      buckets.splice(index, 1);
      nextRawConfig.buckets = buckets;
      await this.persistRawConfig(nextRawConfig);
      return this.directoryView();
    }

    if (!input.name || input.name.trim().length === 0) {
      throw new Error('bucket name is required');
    }

    const nextBucket: Record<string, unknown> = {
      ...(index >= 0 ? buckets[index] : {}),
      id: input.id,
      name: input.name,
    };
    if (input.aliases !== undefined) nextBucket.aliases = input.aliases;
    if (input.note !== undefined) nextBucket.note = input.note;
    if (index >= 0) buckets[index] = nextBucket;
    else buckets.push(nextBucket);
    nextRawConfig.buckets = buckets;
    await this.persistRawConfig(nextRawConfig);
    return this.directoryView();
  }

  async updateProfileLabels(profileId: string, input: ProfileLabelUpdate): Promise<Record<string, unknown>> {
    const hasChange = input.name !== undefined
      || input.aliases !== undefined
      || input.note !== undefined
      || (input.addTags?.length ?? 0) > 0
      || (input.removeTags?.length ?? 0) > 0;
    if (!hasChange) {
      throw new Error('No label fields to update');
    }

    this.getProfile(profileId);
    const loaded = this.ensureLoaded();
    const nextRawConfig = cloneRawConfig(loaded.rawConfig);
    const rawProfile = this.findRawProfile(nextRawConfig, profileId);
    if (!rawProfile) {
      throw new Error(`Raw config profile "${profileId}" not found`);
    }

    if (input.name !== undefined) rawProfile.name = input.name;
    if (input.aliases !== undefined) rawProfile.aliases = input.aliases;
    if (input.note !== undefined) rawProfile.note = input.note;

    if ((input.addTags?.length ?? 0) > 0 || (input.removeTags?.length ?? 0) > 0) {
      const current = Array.isArray(rawProfile.tags)
        ? rawProfile.tags.filter((item): item is string => typeof item === 'string')
        : [];
      const remove = new Set((input.removeTags ?? []).map((tag) => tag.trim().toLowerCase()));
      const nextTags = current.filter((tag) => !remove.has(tag.trim().toLowerCase()));
      for (const tag of input.addTags ?? []) {
        const trimmed = tag.trim();
        if (!trimmed) {
          throw new Error('tag must not be empty');
        }
        if (!nextTags.some((item) => item.trim().toLowerCase() === trimmed.toLowerCase())) {
          nextTags.push(trimmed);
        }
      }
      rawProfile.tags = nextTags;
    }

    await this.persistRawConfig(nextRawConfig);
    return profileSummary(this.getProfile(profileId), this.getActiveProfileId());
  }

  async prepareDeleteProfile(profileId: string): Promise<Record<string, unknown>> {
    const loaded = this.ensureLoaded();
    const profile = this.getProfile(profileId);

    if (loaded.config.profiles.length <= 1) {
      throw new Error('Cannot delete the last profile in config');
    }

    const backupPath = await this.backupCurrentConfig(`delete-${profileId}`);
    const createdAt = Date.now();
    const expiresAt = createdAt + 10 * 60 * 1000;
    const requestId = randomUUID();
    this.pendingDeletes.set(requestId, {
      requestId,
      profileId,
      backupPath,
      createdAt,
      expiresAt,
    });

    return {
      deleteRequestId: requestId,
      profile: profileSummary(profile, this.getActiveProfileId()),
      backupPath,
      expiresAt: new Date(expiresAt).toISOString(),
      confirmationText: `DELETE ${profileId}`,
      warning: 'Deletion is destructive. Confirm with the user before calling profiles-delete-confirm.',
    };
  }

  async confirmDeleteProfile(deleteRequestId: string, profileId: string, confirmationText: string): Promise<Record<string, unknown>> {
    const pending = this.pendingDeletes.get(deleteRequestId);
    if (!pending) {
      throw new Error(`Delete request "${deleteRequestId}" does not exist or expired`);
    }

    if (pending.expiresAt < Date.now()) {
      this.pendingDeletes.delete(deleteRequestId);
      throw new Error(`Delete request "${deleteRequestId}" has expired`);
    }

    if (pending.profileId !== profileId) {
      throw new Error('Delete request profile mismatch');
    }

    const expected = `DELETE ${profileId}`;
    if (confirmationText.trim() !== expected) {
      throw new Error(`Invalid confirmationText. Expected exactly: "${expected}"`);
    }

    const loaded = this.ensureLoaded();
    const profileToDelete = this.getProfile(profileId);
    const nextProfiles = loaded.config.profiles.filter((item) => item.id !== profileId);
    if (nextProfiles.length === 0) {
      throw new Error('Cannot delete the last profile in config');
    }

    const runtimeActiveId = this.getActiveProfileId();
    // Compare the expanded file default, not raw (${ENV} never equals a profile id).
    const fileDefaultActiveId = loaded.config.activeProfile;
    const deletingFileDefault = fileDefaultActiveId === profileId;
    const nextPersistedActiveId = deletingFileDefault
      ? nextProfiles[0].id
      : readPersistedActiveProfileId(loaded.rawConfig, fileDefaultActiveId);
    const survivingStartupPin = this.profileOverride
      && hasProfile(nextProfiles, this.profileOverride)
      ? this.profileOverride
      : undefined;
    const nextRuntimeActiveId = runtimeActiveId === profileId
      ? (survivingStartupPin ?? (deletingFileDefault ? nextProfiles[0].id : fileDefaultActiveId))
      : runtimeActiveId;
    const normalizedRuntimeActiveId = hasProfile(nextProfiles, nextRuntimeActiveId)
      ? nextRuntimeActiveId
      : nextProfiles[0].id;

    const nextRawConfig = cloneRawConfig(loaded.rawConfig);
    const rawProfiles = this.getRawProfiles(nextRawConfig);
    const filteredRawProfiles = rawProfiles.filter((item) => item.id !== profileId);
    if (filteredRawProfiles.length === rawProfiles.length) {
      throw new Error(`Raw config profile "${profileId}" not found`);
    }

    nextRawConfig.profiles = filteredRawProfiles;
    nextRawConfig.activeProfile = nextPersistedActiveId;
    await this.persistRawConfig(nextRawConfig, normalizedRuntimeActiveId);

    this.pendingDeletes.delete(deleteRequestId);
    return {
      deletedProfileId: profileId,
      deletedProfile: profileSummary(profileToDelete, normalizedRuntimeActiveId),
      activeProfile: normalizedRuntimeActiveId,
      persistedActiveProfile: nextPersistedActiveId,
      backupPath: pending.backupPath,
    };
  }

  private getProfile(profileId: string): ProfileDefinition {
    const loaded = this.ensureLoaded();
    const profile = loaded.config.profiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new Error(`Profile "${profileId}" does not exist`);
    }
    return profile;
  }

  private getProfileMaybe(profileId: string): ProfileDefinition | undefined {
    const loaded = this.ensureLoaded();
    return loaded.config.profiles.find((item) => item.id === profileId);
  }

  private async backupCurrentConfig(reason: string): Promise<string> {
    const directory = path.dirname(this.configPath);
    const fileName = path.basename(this.configPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeReason = sanitizeBackupReason(reason);
    const backupDir = path.resolve(directory, '.ssh-mcp-backups');
    await mkdir(backupDir, { recursive: true, mode: 0o700 });

    const backupFileName = `${fileName}.${stamp}.${safeReason}.bak`;
    const backupPath = path.resolve(backupDir, backupFileName);
    const relativePath = path.relative(backupDir, backupPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('Backup path escaped backup directory');
    }

    const content = await readFile(this.configPath, 'utf8');
    await writeFile(backupPath, content, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(backupPath, 0o600);
    }
    return backupPath;
  }
}

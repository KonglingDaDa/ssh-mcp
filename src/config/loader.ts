import { access, readFile, rename, stat, writeFile } from 'fs/promises';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  type LoadedProfilesConfig,
  type ProfileDefinition,
  type ProfilesConfig,
  profilesConfigSchema,
} from './types.js';

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

function inferFormat(filePath: string): 'yaml' | 'json' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  throw new Error(`Unsupported config file extension: ${ext || '<none>'}. Use .yaml/.yml/.json`);
}

function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Config root must be an object');
  }
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function expandEnvString(input: string): string {
  return input.replace(ENV_PATTERN, (_, envName: string) => {
    const envValue = process.env[envName];
    if (envValue === undefined) {
      throw new Error(`Missing required environment variable: ${envName}`);
    }
    return envValue;
  });
}

function expandIfString(target: Record<string, unknown>, key: string): void {
  const value = target[key];
  if (typeof value === 'string') {
    target[key] = expandEnvString(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Expand env only in secret fields and activeProfile. Do not walk the whole tree. */
function expandSecretsInConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const cloned = deepClone(raw);

  expandIfString(cloned, 'activeProfile');

  if (!Array.isArray(cloned.profiles)) {
    return cloned;
  }

  for (const profile of cloned.profiles) {
    if (!isPlainObject(profile)) {
      continue;
    }

    expandIfString(profile, 'suPassword');
    expandIfString(profile, 'sudoPassword');

    if (isPlainObject(profile.auth)) {
      expandIfString(profile.auth, 'password');
      expandIfString(profile.auth, 'keyPath');
    }
  }

  return cloned;
}

function ensureActiveProfileExists(config: ProfilesConfig): void {
  const exists = config.profiles.some((profile) => profile.id === config.activeProfile);
  if (!exists) {
    throw new Error(`activeProfile "${config.activeProfile}" does not exist in profiles`);
  }
}

export function resolveKeyPath(keyPath: string, configFilePath: string): string {
  if (path.isAbsolute(keyPath)) {
    return keyPath;
  }
  const baseDir = path.dirname(configFilePath);
  return path.resolve(baseDir, keyPath);
}

export interface ValidateProfileAuthOptions {
  checkKeyPathExists?: boolean;
}

async function validateProfileAuthFields(
  config: ProfilesConfig,
  filePath: string,
  options: ValidateProfileAuthOptions = {},
): Promise<void> {
  const checkKeyPathExists = options.checkKeyPathExists !== false;
  for (const profile of config.profiles) {
    if (profile.auth.type === 'password') {
      if (!profile.auth.password || profile.auth.password.trim() === '') {
        throw new Error(`Profile "${profile.id}" requires auth.password`);
      }
    }
    if (profile.auth.type === 'key') {
      if (!profile.auth.keyPath || profile.auth.keyPath.trim() === '') {
        throw new Error(`Profile "${profile.id}" requires auth.keyPath`);
      }
      if (!checkKeyPathExists) {
        continue;
      }
      const resolvedPath = resolveKeyPath(profile.auth.keyPath, filePath);
      try {
        await access(resolvedPath);
      } catch {
        throw new Error(`Profile "${profile.id}" keyPath does not exist: ${resolvedPath}`);
      }
    }
  }
}

export async function validateRawProfilesConfig(
  rawConfig: Record<string, unknown>,
  filePath: string,
  options: ValidateProfileAuthOptions = {},
): Promise<ProfilesConfig> {
  const expandedConfig = expandSecretsInConfig(rawConfig);
  const parsedConfig = profilesConfigSchema.parse(expandedConfig);
  ensureActiveProfileExists(parsedConfig);
  await validateProfileAuthFields(parsedConfig, filePath, options);
  return parsedConfig;
}

function parseRawContent(content: string, format: 'yaml' | 'json'): Record<string, unknown> {
  if (format === 'json') {
    const parsed = JSON.parse(content);
    assertObject(parsed);
    return parsed;
  }
  const parsed = parseYaml(content);
  assertObject(parsed);
  return parsed;
}

export async function loadProfilesConfig(filePath: string): Promise<LoadedProfilesConfig> {
  const format = inferFormat(filePath);
  const content = await readFile(filePath, 'utf8');
  const rawConfig = parseRawContent(content, format);
  const parsedConfig = await validateRawProfilesConfig(rawConfig, filePath, {
    checkKeyPathExists: false,
  });

  return {
    filePath,
    format,
    config: parsedConfig,
    rawConfig,
  };
}

function serializeRawConfig(rawConfig: Record<string, unknown>, format: 'yaml' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify(rawConfig, null, 2) + '\n';
  }
  return stringifyYaml(rawConfig);
}

export async function saveRawProfilesConfig(loaded: LoadedProfilesConfig): Promise<void> {
  const output = serializeRawConfig(loaded.rawConfig, loaded.format);
  const tmpPath = `${loaded.filePath}.${process.pid}.tmp`;
  let mode = 0o600;
  try {
    const existing = await stat(loaded.filePath);
    mode = existing.mode & 0o777;
  } catch {
    // New file: default to owner-only.
  }
  await writeFile(tmpPath, output, { encoding: 'utf8', mode });
  await rename(tmpPath, loaded.filePath);
}

export function profileSummary(profile: ProfileDefinition, activeProfileId: string): Record<string, unknown> {
  const authSummary = profile.auth.type === 'password'
    ? { type: 'password' as const, password: '***' }
    : {
      type: 'key' as const,
      keyPath: path.basename(profile.auth.keyPath),
    };

  return {
    id: profile.id,
    name: profile.name,
    aliases: profile.aliases ?? [],
    host: profile.host,
    port: profile.port,
    user: profile.user,
    note: profile.note ?? '',
    tags: profile.tags ?? [],
    auth: authSummary,
    active: profile.id === activeProfileId,
    elevatedViaSu: Boolean(profile.suPassword),
  };
}

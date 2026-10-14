import { z } from 'zod';

const intFromStringSchema = z.string().regex(/^-?\d+$/).transform((value) => Number.parseInt(value, 10));

const intLikeSchema = z.union([
  z.number().int(),
  intFromStringSchema,
]).transform((value) => value as number);

const positiveIntLikeSchema = intLikeSchema.refine(
  (value) => value > 0,
  { message: 'must be a positive integer' },
);

const booleanLikeSchema = z.union([z.boolean(), z.string()]).transform((value, ctx) => {
  if (typeof value === 'boolean') return value;
  const lowered = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
  if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'must be a boolean-like value',
  });
  return z.NEVER;
});

export const maxCharsConfigSchema = z.union([
  z.literal('none'),
  intLikeSchema,
]);

const passwordAuthSchema = z.object({
  type: z.literal('password'),
  password: z.string().min(1, 'password auth requires a non-empty password'),
}).strict();

const keyAuthSchema = z.object({
  type: z.literal('key'),
  keyPath: z.string().min(1, 'key auth requires a non-empty keyPath'),
}).strict();

export const profileAuthSchema = z.discriminatedUnion('type', [
  passwordAuthSchema,
  keyAuthSchema,
]);

export const profileDefaultsSchema = z.object({
  timeout: positiveIntLikeSchema.optional(),
  maxChars: maxCharsConfigSchema.optional(),
  disableSudo: booleanLikeSchema.optional(),
}).default({});

const portSchema = positiveIntLikeSchema.refine((value) => value <= 65535, {
  message: 'port must be between 1 and 65535',
});

export const profileIdSchema = z.string()
  .min(1, 'profile id is required')
  .max(80, 'profile id must be 80 characters or fewer')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'profile id must use only letters, numbers, dot, underscore, or hyphen, and must start with a letter or number',
  );

const singleLineText = (label: string) => z.string()
  .min(1, `${label} is required`)
  .refine((value) => !/[\r\n]/.test(value), {
    message: `${label} must be a single line`,
  });

const aliasSchema = z.string()
  .min(1, 'alias must not be empty')
  .max(80, 'alias must be 80 characters or fewer')
  .refine((value) => value.trim().length > 0 && !/[\r\n]/.test(value), {
    message: 'alias must be a non-empty single line',
  });

const bucketNameSchema = z.string()
  .min(1, 'bucket name is required')
  .max(80, 'bucket name must be 80 characters or fewer')
  .refine((value) => !/[\r\n]/.test(value), {
    message: 'bucket name must be a single line',
  });

export const bucketSchema = z.object({
  id: profileIdSchema,
  name: bucketNameSchema,
  aliases: z.array(aliasSchema).max(8).default([]),
  note: z.string().max(200).default(''),
}).strict();

export const profileSchema = z.object({
  id: profileIdSchema,
  name: singleLineText('profile name'),
  aliases: z.array(aliasSchema).max(8).default([]),
  host: singleLineText('profile host'),
  port: portSchema.default(22),
  user: z.string().min(1, 'profile user is required'),
  auth: profileAuthSchema,
  suPassword: z.string().min(1).optional(),
  sudoPassword: z.string().min(1).optional(),
  note: z.string().max(500).default(''),
  tags: z.array(z.string()).default([]),
}).strict();

export const profilesConfigSchema = z.object({
  version: z.literal(1),
  activeProfile: profileIdSchema,
  defaults: profileDefaultsSchema.optional().default({}),
  buckets: z.array(bucketSchema).default([]),
  profiles: z.array(profileSchema).min(1, 'at least one profile is required'),
}).strict().superRefine((value, ctx) => {
  const seenIds = new Set<string>();
  for (const profile of value.profiles) {
    if (seenIds.has(profile.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate profile id: ${profile.id}`,
        path: ['profiles'],
      });
    }
    seenIds.add(profile.id);
  }

  const seenBucketIds = new Set<string>();
  const seenBucketTokens = new Map<string, string>();
  for (const bucket of value.buckets) {
    if (seenBucketIds.has(bucket.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate bucket id: ${bucket.id}`,
        path: ['buckets'],
      });
    }
    seenBucketIds.add(bucket.id);
    for (const token of [bucket.id, bucket.name, ...bucket.aliases]) {
      const key = token.trim().toLowerCase();
      if (!key) continue;
      const owner = seenBucketTokens.get(key);
      if (owner && owner !== bucket.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `bucket token "${token}" is used by both "${owner}" and "${bucket.id}"`,
          path: ['buckets'],
        });
      }
      seenBucketTokens.set(key, bucket.id);
    }
  }
});

export type ProfileAuth = z.infer<typeof profileAuthSchema>;
export type ProfileDefaults = z.infer<typeof profileDefaultsSchema>;
export type BucketDefinition = z.infer<typeof bucketSchema>;
export type ProfileDefinition = z.infer<typeof profileSchema>;
export type ProfilesConfig = z.infer<typeof profilesConfigSchema>;

export interface LoadedProfilesConfig {
  filePath: string;
  format: 'yaml' | 'json';
  config: ProfilesConfig;
  rawConfig: Record<string, unknown>;
}

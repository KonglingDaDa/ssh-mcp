import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { profileIdSchema } from '../config/types.js';
import { ProfileManager, type BucketUpsertInput, type ProfileCreateInput, type ProfileLabelUpdate } from '../profile/profile-manager.js';
import { buildSshConfigFromProfile } from '../ssh/ssh-config.js';
import { testSshConnection } from '../ssh/connection-manager.js';
import { asTextResult } from './result.js';

export interface ProfileToolDependencies {
  profileManager: ProfileManager;
  onTargetChanged: () => Promise<void>;
}

function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  const message = (err as Error)?.message ?? String(err);
  return new McpError(ErrorCode.InvalidParams, message);
}

export function registerProfileTools(server: McpServer, deps: ProfileToolDependencies): void {
  server.tool(
    'profiles-list',
    'Read-only bucket directory plus the current target. Does not return every machine. activeProfile/sessionActiveProfile is this MCP session; fileActiveProfile is the on-disk default. startupProfileOverride is the startup --profile pin, or null. Open a bucket or search with profiles-find. Do not call profiles-use just to look.',
    {},
    async () => {
      try {
        return asTextResult({
          configPath: deps.profileManager.getConfigPath(),
          ...deps.profileManager.directoryView(),
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-use',
    'Switches the session target for later exec/sudo-exec. Not a read, not a preview, not a connectivity test. Call only when the user explicitly asked to change machines. Does not write the file default. profiles-reload or process restart discards this switch. To inspect the current target, call profiles-list.',
    {
      profileId: z.string().min(1).describe('Exact profile id to switch this session to. Does not persist. Do not call this to inspect.'),
    },
    async ({ profileId }) => {
      try {
        const profile = await deps.profileManager.setActiveProfile(profileId, false);
        await deps.onTargetChanged();
        return asTextResult({
          ...deps.profileManager.getTargetView(),
          persisted: false,
          profile,
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-reload',
    'Re-reads the profiles file in this MCP session and returns the bucket directory, not every machine. Discards any session-only profiles-use. Resolves the session target from startup --profile (wins if still valid) or fileActiveProfile. Restart the server only if startup args or disableSudo (tool surface) changed.',
    {},
    async () => {
      try {
        const result = await deps.profileManager.reload();
        await deps.onTargetChanged();
        return asTextResult(result);
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-note-update',
    'Update the note for one profile and persist it. Chinese or English, up to 500 characters. Prefer profiles-label-update when also changing name, aliases, or tags.',
    {
      profileId: z.string().min(1).describe('Profile id to update'),
      note: z.string().max(500).describe('Operational remark, Chinese or English, up to 500 characters'),
    },
    async ({ profileId, note }) => {
      try {
        const profile = await deps.profileManager.updateNote(profileId, note);
        return asTextResult({
          updatedProfileId: profileId,
          profile,
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-find',
    'Return matching machines only. Pass bucket (directory id, Chinese or English bucket name, or an exact tag) and/or query (id, name, alias, host, note, tag). At least one is required; an empty call is rejected. Does not switch targets. After you pick an exact id, call profiles-use only if the user asked to change machines.',
    {
      query: z.string().optional().describe('Keyword in Chinese or English. Matches id, name, aliases, host, user, note, and tags.'),
      bucket: z.string().optional().describe('Directory bucket id, bucket name, bucket alias, or an exact tag. Does not return machines outside that set.'),
    },
    async ({ query, bucket }) => {
      try {
        return asTextResult(deps.profileManager.searchProfiles({ query, bucket }));
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-bucket-upsert',
    'Create, rename, or remove a directory bucket in the same config file. Membership is a profile tag equal to the bucket id, name, or alias. remove=true deletes the directory entry only, not the machines. Does not switch targets.',
    {
      id: profileIdSchema.describe('ASCII bucket id, such as production or customer'),
      name: z.string().min(1).max(80).optional().describe('Display name, Chinese or English. Required unless remove=true'),
      aliases: z.array(z.string().min(1).max(80)).max(8).optional().describe('Extra names used to open this bucket. Chinese or English.'),
      note: z.string().max(200).optional().describe('Short directory note. Not a machine note.'),
      remove: z.boolean().optional().describe('true deletes this directory entry only'),
    },
    async (input) => {
      try {
        const payload: BucketUpsertInput = {
          id: input.id,
          name: input.name,
          aliases: input.aliases,
          note: input.note,
          remove: input.remove,
        };
        return asTextResult(await deps.profileManager.upsertBucket(payload));
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-label-update',
    'Update one machine display name, aliases, note, or tags. Chinese and English are both allowed. To place a machine in a directory bucket, addTags the bucket id (or its name/alias). Does not change auth, passwords, or the session target.',
    {
      profileId: z.string().min(1).describe('Exact profile id'),
      name: z.string().min(1).optional().describe('Display name, Chinese or English, single line'),
      aliases: z.array(z.string().min(1).max(80)).max(8).optional().describe('Replacement alias list. Omit to leave aliases unchanged.'),
      note: z.string().max(500).optional().describe('Operational remark, up to 500 characters. Chinese or English.'),
      addTags: z.array(z.string().min(1)).optional().describe('Tags to add. Use a bucket id to put the machine in that bucket.'),
      removeTags: z.array(z.string().min(1)).optional().describe('Tags to remove. Does not delete the machine.'),
    },
    async (input) => {
      try {
        const labels: ProfileLabelUpdate = {
          name: input.name,
          aliases: input.aliases,
          note: input.note,
          addTags: input.addTags,
          removeTags: input.removeTags,
        };
        const profile = await deps.profileManager.updateProfileLabels(input.profileId, labels);
        return asTextResult({
          updatedProfileId: input.profileId,
          profile,
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-test',
    'Connectivity only (TCP, SSH handshake, auth). Does not switch the session target and is not a substitute for profiles-list. Omit profileId only after you already confirmed sessionActiveProfile.',
    {
      profileId: z.string().min(1).optional().describe('Optional profile id; defaults to current active profile'),
      timeoutMs: z.number()
        .int()
        .positive()
        .max(60 * 1000)
        .optional()
        .describe('Optional timeout per attempt in milliseconds (default 10000)'),
      retries: z.number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe('Retry count for handshake/network failures (default 2)'),
    },
    async ({ profileId, timeoutMs, retries }) => {
      try {
        const profile = profileId
          ? deps.profileManager.getProfileById(profileId)
          : deps.profileManager.getActiveProfile();
        const sshConfig = await buildSshConfigFromProfile(profile, deps.profileManager.getConfigPath());
        const result = await testSshConnection(sshConfig, { timeoutMs, retries });
        return asTextResult({
          profileId: profile.id,
          result,
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-create',
    'Persists a new profile into the config file. activate defaults to false: the profile is written but the file default and this session stay unchanged. activate true switches this session only and still does not write fileActiveProfile. After create, call profiles-list before exec. To run commands on the new machine, call profiles-use if you did not pass activate true.',
    {
      id: profileIdSchema.describe('Unique profile id: ASCII slug using letters, numbers, dot, underscore, or hyphen'),
      name: z.string().min(1).describe('Human-readable profile name'),
      host: z.string().min(1).describe('SSH host or IP'),
      port: z.number().int().min(1).max(65535).optional().describe('SSH port, default 22'),
      user: z.string().min(1).describe('SSH username'),
      authType: z.enum(['password', 'key']).describe('Authentication method'),
      password: z.string().optional().describe('Required when authType=password; plain value or ${ENV_VAR}'),
      keyPath: z.string().optional().describe('Required when authType=key; absolute or config-relative path'),
      suPassword: z.string().optional().describe('If set, every later exec on this profile runs via su -c (already elevated). Leave unset for a normal login user.'),
      sudoPassword: z.string().optional().describe('Used only by sudo-exec, never by exec. Prefer ${ENV_VAR} placeholders.'),
      note: z.string().max(500).optional().describe('Operational remark, Chinese or English, up to 500 characters'),
      aliases: z.array(z.string().min(1).max(80)).max(8).optional().describe('Extra Chinese or English names used for search. id stays ASCII'),
      contextSummary: z.string().optional().describe('Optional context used to auto-generate note when note is omitted'),
      tags: z.array(z.string()).optional().describe('Keyword tags. Include a bucket id, name, or alias to place the machine in that directory bucket'),
      activate: z.boolean().optional().describe('Default false. true = switch this session only; never writes fileActiveProfile. false = write the profile only.'),
    },
    async (input) => {
      try {
        let auth: ProfileCreateInput['auth'];
        if (input.authType === 'password') {
          if (!input.password || input.password.trim().length === 0) {
            throw new Error('password is required when authType=password');
          }
          auth = { type: 'password', password: input.password };
        } else {
          if (!input.keyPath || input.keyPath.trim().length === 0) {
            throw new Error('keyPath is required when authType=key');
          }
          auth = { type: 'key', keyPath: input.keyPath };
        }

        const profile = await deps.profileManager.createProfile({
          id: input.id,
          name: input.name,
          host: input.host,
          port: input.port,
          user: input.user,
          auth,
          suPassword: input.suPassword,
          sudoPassword: input.sudoPassword,
          note: input.note,
          aliases: input.aliases,
          contextSummary: input.contextSummary,
          tags: input.tags,
          activate: input.activate,
        });

        if (input.activate === true) {
          await deps.onTargetChanged();
        }

        return asTextResult({
          createdProfileId: input.id,
          ...deps.profileManager.getTargetView(),
          persisted: true,
          fileDefaultChanged: false,
          sessionActivated: input.activate === true,
          profile,
        });
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-delete-prepare',
    'Prepare deletion for a profile. This step creates a backup and returns a deleteRequestId + confirmationText. Always show result to the user and ask explicit confirmation before calling profiles-delete-confirm.',
    {
      profileId: z.string().min(1).describe('Exact profile id to delete'),
    },
    async ({ profileId }) => {
      try {
        const result = await deps.profileManager.prepareDeleteProfile(profileId);
        return asTextResult(result);
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'profiles-delete-confirm',
    'Execute profile deletion after explicit user confirmation. Requires deleteRequestId and exact confirmationText from profiles-delete-prepare response.',
    {
      deleteRequestId: z.string().min(1).describe('Delete request id returned by profiles-delete-prepare'),
      profileId: z.string().min(1).describe('Exact profile id to delete'),
      confirmationText: z.string().min(1).describe('Must exactly match the confirmationText returned by prepare step'),
    },
    async ({ deleteRequestId, profileId, confirmationText }) => {
      try {
        const result = await deps.profileManager.confirmDeleteProfile(
          deleteRequestId,
          profileId,
          confirmationText,
        );
        await deps.onTargetChanged();
        return asTextResult(result);
      } catch (err: unknown) {
        throw toMcpError(err);
      }
    },
  );
}

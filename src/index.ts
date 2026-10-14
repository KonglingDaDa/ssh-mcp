#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  determineStartupMode,
  parseArgv,
  resolveRuntimeOptions,
  type ArgvConfig,
  type RuntimeOptions,
  type StartupMode,
} from './cli/args.js';
import type { ProfileDefinition } from './config/types.js';
import { ProfileManager } from './profile/profile-manager.js';
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_TIMEOUT_MS,
  sanitizeCommand,
} from './ssh/command-utils.js';
import {
  SSHConnectionManager,
  execSshCommand,
  execSshCommandWithConnection,
} from './ssh/connection-manager.js';
import { buildSshConfigFromProfile } from './ssh/ssh-config.js';
import { registerExecTool } from './tools/exec.js';
import { registerProfileTools } from './tools/profiles.js';
import { registerSudoExecTool } from './tools/sudo-exec.js';

const isTestMode = process.env.SSH_MCP_TEST === '1';
const isCliEnabled = process.env.SSH_MCP_DISABLE_MAIN !== '1';
const shouldBootServer = isCliEnabled || isTestMode;
const argvConfig: ArgvConfig = shouldBootServer ? parseArgv() : {};

const server = new McpServer({
  name: 'SSH MCP Server',
  version: '2.0.0',
  capabilities: {
    resources: {},
    tools: {},
  },
});

let startupMode: StartupMode | null = null;
let profileManager: ProfileManager | null = null;
let connectionManager: SSHConnectionManager | null = null;
let connectionOpening: Promise<SSHConnectionManager> | null = null;
let initialRuntimeOptions: RuntimeOptions = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxChars: DEFAULT_MAX_CHARS,
  disableSudo: false,
};

function getActiveProfile(): ProfileDefinition {
  if (!profileManager) {
    throw new McpError(ErrorCode.InternalError, 'Profile mode not initialized');
  }
  return profileManager.getActiveProfile();
}

function getRuntimeOptions(): RuntimeOptions {
  if (profileManager) {
    const resolved = resolveRuntimeOptions(argvConfig, profileManager.getDefaults());
    return {
      ...resolved,
      disableSudo: initialRuntimeOptions.disableSudo,
    };
  }
  return initialRuntimeOptions;
}

async function closeConnectionManager(): Promise<void> {
  connectionOpening = null;
  if (!connectionManager) return;
  connectionManager.close();
  connectionManager = null;
}

async function openConnection(profile: ProfileDefinition): Promise<SSHConnectionManager> {
  if (!profileManager) {
    throw new McpError(ErrorCode.InternalError, 'Profile mode not initialized');
  }
  const sshConfig = await buildSshConfigFromProfile(profile, profileManager.getConfigPath());
  if (getActiveProfile().id !== profile.id) {
    throw new McpError(ErrorCode.InternalError, 'Profile changed while opening SSH connection');
  }
  if (!connectionManager || connectionManager.getProfileId() !== profile.id) {
    connectionManager?.close();
    connectionManager = new SSHConnectionManager(sshConfig);
  }
  return connectionManager;
}

async function getConnectionContext(): Promise<{
  manager: SSHConnectionManager;
  profile: ProfileDefinition;
}> {
  const profile = getActiveProfile();
  if (connectionManager && connectionManager.getProfileId() !== profile.id) {
    await closeConnectionManager();
  }

  if (!connectionManager) {
    if (!connectionOpening) {
      connectionOpening = openConnection(profile).finally(() => {
        connectionOpening = null;
      });
    }
    await connectionOpening;
  }

  if (!connectionManager || connectionManager.getProfileId() !== getActiveProfile().id) {
    throw new McpError(ErrorCode.InternalError, 'SSH connection was not initialized for the active profile');
  }
  return { manager: connectionManager, profile: getActiveProfile() };
}

async function initializeRuntime(): Promise<void> {
  startupMode = determineStartupMode(argvConfig);
  profileManager = new ProfileManager(startupMode.configPath, startupMode.profileIdOverride);
  await profileManager.initialize();
  initialRuntimeOptions = resolveRuntimeOptions(argvConfig, profileManager.getDefaults());
}

function registerTools(): void {
  registerExecTool(server, {
    getConnectionContext,
    getRuntimeOptions,
  });

  if (!getRuntimeOptions().disableSudo) {
    registerSudoExecTool(server, {
      getConnectionContext,
      getRuntimeOptions,
    });
  }

  if (profileManager) {
    registerProfileTools(server, {
      profileManager,
      onTargetChanged: closeConnectionManager,
    });
  }
}

async function bootstrapServer(): Promise<void> {
  await initializeRuntime();
  registerTools();
}

async function runMain(): Promise<void> {
  await bootstrapServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('SSH MCP Server running on stdio');

  const cleanup = () => {
    closeConnectionManager()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    if (connectionManager) {
      connectionManager.close();
    }
  });
}

if (isTestMode) {
  bootstrapServer()
    .then(async () => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    })
    .catch((error) => {
      console.error('Fatal error connecting server:', error);
      process.exit(1);
    });
} else if (isCliEnabled) {
  runMain().catch((error) => {
    console.error('Fatal error in main():', error);
    closeConnectionManager().finally(() => process.exit(1));
  });
}

export {
  parseArgv,
  sanitizeCommand,
  SSHConnectionManager,
  execSshCommandWithConnection,
  execSshCommand,
};

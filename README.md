# SSH MCP Server

[![NPM Version](https://img.shields.io/npm/v/ssh-mcp)](https://www.npmjs.com/package/ssh-mcp)
[![Downloads](https://img.shields.io/npm/dm/ssh-mcp)](https://www.npmjs.com/package/ssh-mcp)
[![Node Version](https://img.shields.io/node/v/ssh-mcp)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/Bianshumeng/ssh-mcp)](./LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/Bianshumeng/ssh-mcp?style=social)](https://github.com/Bianshumeng/ssh-mcp/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/Bianshumeng/ssh-mcp?style=social)](https://github.com/Bianshumeng/ssh-mcp/forks)
[![Build Status](https://github.com/Bianshumeng/ssh-mcp/actions/workflows/publish.yml/badge.svg)](https://github.com/Bianshumeng/ssh-mcp/actions)
[![GitHub issues](https://img.shields.io/github/issues/Bianshumeng/ssh-mcp)](https://github.com/Bianshumeng/ssh-mcp/issues)

[![Trust Score](https://archestra.ai/mcp-catalog/api/badge/quality/Bianshumeng/ssh-mcp)](https://archestra.ai/mcp-catalog/Bianshumeng__ssh-mcp)

**SSH MCP Server** is a local Model Context Protocol (MCP) server that exposes SSH control for Linux and Windows systems, enabling LLMs and other MCP clients to execute shell commands securely via SSH.

## Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Installation](#installation)
- [Client Setup](#client-setup)
- [AI Usage Skill](#ai-usage-skill)
- [Testing](#testing)
- [Disclaimer](#disclaimer)
- [Support](#support)

## Quick Start

- [Install](#installation) SSH MCP Server
- [Configure](#configuration) SSH MCP Server
- [Set up](#client-setup) your MCP Client (e.g. Claude Desktop, Cursor, etc)
- Execute remote shell commands on your Linux or Windows server via natural language

## Features

- MCP-compliant server exposing SSH capabilities
- Execute shell commands on remote Linux and Windows systems
- Secure authentication via password or SSH key
- Local profile configuration via YAML/JSON files
- Runtime profile management tools (`profiles-list/find/use/reload/note-update/profiles-test`)
- Profile notes/tags for operational context
- Built with TypeScript and the official MCP SDK
- **Configurable timeout protection** with SSH channel termination and connection cleanup
- **Graceful timeout handling** - requests remote command termination when supported, then closes the channel and connection

### Tools

- `exec`: Execute a shell command on the remote server
  - **Parameters:**
    - `command` (required): Shell command to execute on the remote SSH server
    - `description` (optional): Optional client-side description of what this command will do; it is not appended to the executable command
    - `timeoutMs` (optional): Per-command timeout override in milliseconds
  - **Timeout Configuration:**

- `sudo-exec`: Execute a shell command with sudo elevation
  - **Parameters:**
    - `command` (required): Shell command to execute as root using sudo
    - `description` (optional): Optional client-side description of what this command will do; it is not appended to the executable command
    - `timeoutMs` (optional): Per-command timeout override in milliseconds
  - **Notes:**
    - Requires `sudoPassword` on the active profile for password-protected sudo
    - Can be disabled with `--disableSudo` or startup config defaults if sudo access is not needed or not available
    - When `suPassword` is configured on the active profile, `exec` runs each command through `su -c` instead of keeping a shared root shell open
    - Tool will not be available at all if server is started with `--disableSudo`
  - **Timeout Configuration:**
    - Timeout is configured via command line argument `--timeout` (in milliseconds)
    - Default timeout: 60000ms (1 minute)
    - When a command times out, the server sends `TERM` when supported, closes the SSH channel, and drops the connection; remote child cleanup depends on the SSH server and command behavior
  - **Max Command Length Configuration:**
    - Max command characters are configured via `--maxChars`
    - Default: `1000`
    - No-limit mode: set `--maxChars=none` or any `<= 0` value (e.g. `--maxChars=0`)

- `profiles-list`: List profile summaries (`id/name/host/port/note/tags/active`) with sensitive fields masked
- `profiles-find`: Find profile candidates by keyword across `id/name/host/user/note/tags`
- `profiles-test`: Test TCP connectivity, SSH handshake, and authentication for a profile
- `profiles-use`: Switch active profile at runtime, persist `activeProfile`, and recreate SSH connection on next command
- `profiles-reload`: Reload profile configuration from disk and resolve the active profile from startup override or file `activeProfile`
- `profiles-create`: Create profile templates dynamically at runtime (note optional but recommended)
- `profiles-note-update`: Update and persist a concise profile note
- `profiles-delete-prepare`: Prepare destructive deletion (creates backup and returns confirmation payload)
- `profiles-delete-confirm`: Finalize deletion with exact `deleteRequestId + confirmationText`

## Installation

1. **Clone the repository:**
   ```bash
  git clone https://github.com/Bianshumeng/ssh-mcp.git
   cd ssh-mcp
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```

## Client Setup

You can configure your IDE or LLM like Cursor, Windsurf, Claude Desktop to use this MCP Server.

### Profile Mode

This server now runs in profile mode only.

Use `--config` to load multiple SSH profiles from a local YAML/JSON file.

**Parameters:**
- `config`: Path to profile config file (`.yaml`, `.yml`, `.json`)
- `profile`: Optional profile id override for startup active profile
- `timeout`: Optional command timeout override in milliseconds
- `maxChars`: Optional command length override
- `disableSudo`: Optional flag to disable `sudo-exec`

**Important:**
- Legacy startup args (`--host`, `--user`, `--password`, `--key`, etc.) are no longer supported.
- Dynamic target management is done through profile tools (`profiles-list/find/use/create/delete-*`).

Example:

```bash
npx -y ssh-mcp -- --config=./examples/ssh-mcp.profiles.yaml --profile=jp-relay
```

### Profile Configuration Format

The full example is available at `examples/ssh-mcp.profiles.yaml`.

```yaml
version: 1
activeProfile: fi-template

defaults:
  timeout: 120000
  maxChars: none
  disableSudo: false

profiles:
  - id: fi-template
    name: 芬兰模板机
    host: fi-template.example.com
    port: 9900
    user: root
    auth:
      type: password
      password: "${SSH_TEMPLATE_PASSWORD}"
    sudoPassword: "${SSH_TEMPLATE_SUDO_PASSWORD}"
    note: "模板维护机，做 cloud-init 和预装验证"
    tags: [template, fi]
```

Notes:
- `${ENV_VAR}` placeholders are expanded at load time
- `profiles[].id` and `activeProfile` must be stable ASCII slugs: letters, numbers, `.`, `_`, or `-`, starting with a letter or number; use `name` for human-readable labels such as Chinese server names
- `auth.type=password` requires `auth.password`
- `auth.type=key` requires `auth.keyPath` and the file must exist
- `activeProfile` must match one of `profiles[].id`
- `profiles-reload` re-reads the file and uses the file's `activeProfile` unless a startup `--profile` override is still valid
- `disableSudo` changes the MCP tool surface, so it is resolved at startup; restart the MCP server after changing it in config
- Profile list output and tool responses never expose plaintext passwords

### Dynamic Template Management Workflow

1. Create template at runtime:
   - call `profiles-create`
   - by default, created profile is activated immediately
2. Keep note short and precise:
   - if `note` is omitted, tool can derive a concise note from `contextSummary`
3. Validate target quickly:
   - call `profiles-test` to verify TCP/SSH/auth before executing commands
4. Safe deletion (two-step):
   - call `profiles-delete-prepare` first
   - review returned profile + backup path + confirmation text with user
   - only then call `profiles-delete-confirm`

`profiles-delete-confirm` requires exact confirmation text in the form:

```text
DELETE <profileId>
```

This guards against accidental profile removal and ensures a backup exists before delete.

### Claude Code

You can add this MCP server to Claude Code using the `claude mcp add` command. This is the recommended method for Claude Code.

**Basic Installation:**

```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --config=/path/to/ssh-mcp.profiles.yaml
```

**Installation Examples:**

**With Config File:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --config=./examples/ssh-mcp.profiles.yaml
```

**With Startup Profile Override:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --config=./examples/ssh-mcp.profiles.yaml --profile=jp-relay
```

**With Custom Timeout and No Character Limit:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --config=./examples/ssh-mcp.profiles.yaml --timeout=120000 --maxChars=none
```

**With Sudo Tool Disabled:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --config=./examples/ssh-mcp.profiles.yaml --disableSudo
```

**Installation Scopes:**

You can specify the scope when adding the server:

- **Local scope** (default): For personal use in the current project
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope local -- npx -y ssh-mcp -- --config=/path/to/ssh-mcp.profiles.yaml
  ```

- **Project scope**: Share with your team via `.mcp.json` file
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope project -- npx -y ssh-mcp -- --config=./config/ssh-mcp.profiles.yaml
  ```

- **User scope**: Available across all your projects
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope user -- npx -y ssh-mcp -- --config=/absolute/path/to/ssh-mcp.profiles.yaml
  ```


**Verify Installation:**

After adding the server, restart Claude Code and ask Cascade to execute a command:
```
"Can you run 'ls -la' on the remote server?"
```

For more information about MCP in Claude Code, see the [official documentation](https://docs.claude.com/en/docs/claude-code/mcp).

## AI Usage Skill

This repository includes a Codex skill at `skills/ssh-mcp-operator/` for teaching AI agents how to use this MCP server after local deployment.

After cloning the repository, copy or symlink `skills/ssh-mcp-operator/` into your Codex skills directory, then invoke it as:

```text
$ssh-mcp-operator
```

The skill teaches the agent to:

- discover the current config path and active profile with `profiles-list` (read-only verify; do not use `profiles-use` just to inspect)
- find targets by `id/name/host/note/tags` with `profiles-find`
- switch targets with `profiles-use` only when the user asks to change machines; this persists `activeProfile`
- hot-load `ssh-mcp.profiles.yaml` changes with `profiles-reload`, then re-check `profiles-list` (`--profile` startup override still wins after reload)
- test targets with `profiles-test` before important commands
- use `exec` and `sudo-exec` safely, including timeouts and destructive-command confirmation
- treat `exec` as already elevated via `su -c` when the profile has `suPassword`; keep `sudo-exec` for `sudo` only
- keep profile `id` values as ASCII slugs while allowing Chinese display names in `name`

## Testing

You can use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) for visual debugging of this MCP Server.

```sh
npm run inspect
```

## Disclaimer

SSH MCP Server is provided under the [MIT License](./LICENSE). Use at your own risk. This project is not affiliated with or endorsed by any SSH or MCP provider.

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](./CONTRIBUTING.md) for more information.

## Code of Conduct

This project follows a [Code of Conduct](./CODE_OF_CONDUCT.md) to ensure a welcoming environment for everyone.

## Support

If you find SSH MCP Server helpful, consider starring the repository or contributing! Pull requests and feedback are welcome. 

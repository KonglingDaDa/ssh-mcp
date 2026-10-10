---
name: ssh-mcp-operator
description: Use this skill when operating this repository's SSH MCP server after local deployment, including configuring profiles, selecting SSH targets, reloading ssh-mcp.profiles.yaml, testing connections, and safely running exec or sudo-exec commands through the MCP tools.
---

# SSH MCP Operator

Use this skill after a user has installed or cloned this `ssh-mcp` server and wants an AI agent to operate remote machines through its MCP tools.

## Core Model

- This server runs in profile mode only. It must be started with `--config=<path-to-ssh-mcp.profiles.yaml>`.
- The profile config can be YAML or JSON. The repository example is `examples/ssh-mcp.profiles.yaml`.
- `profiles[].id` is the stable machine identifier and must be an ASCII slug using letters, numbers, `.`, `_`, or `-`, starting with a letter or number.
- `profiles[].name` is the human-readable label and can use Chinese or any other display language.
- Secrets should be environment placeholders such as `${SSH_TEMPLATE_PASSWORD}` instead of plaintext when possible.
- `profiles-reload` re-reads the config file in the same MCP session. If the server was started with `--profile=<id>`, reload still prefers that startup override over the file's `activeProfile`. Restart the MCP server only when startup args or `disableSudo` tool availability change.
- When a profile has `suPassword`, every `exec` runs through `su -c` and is already elevated. `sudo-exec` is only for `sudo`. Profile list summaries do not show whether `suPassword` is set.

## Normal Workflow

1. Call `profiles-list` first to see `configPath`, the active profile, and available profile summaries. This is the only read-only check for the current target.
2. If the user names a target ambiguously, call `profiles-find` with the provided keyword and choose by `id`, `name`, `host`, `note`, or `tags`.
3. Call `profiles-use` with the exact `profileId` only when the user explicitly wants to switch targets. It persists `activeProfile` to the config file. Never call it just to inspect the current target.
4. Call `profiles-test` before important work on a new, changed, or uncertain target.
5. Use `exec` for ordinary commands when the profile has no `suPassword`. If `suPassword` is configured, treat every `exec` as already elevated via `su`. Use `sudo-exec` only when `sudo` is required and the tool is available.
6. Include concise `description` values on command tools so the client log explains intent; the description is not sent to the remote shell.
7. Use `timeoutMs` for long-running commands rather than assuming the default is enough.
8. After `profiles-reload` or `profiles-use`, call `profiles-list` again and read `activeProfile` before any state-changing command.

## Adding Or Updating Profiles

Prefer `profiles-create` when the MCP tool is available and the user gives enough target information. It persists the new profile and activates it by default unless `activate: false` is passed.

When editing `ssh-mcp.profiles.yaml` directly:

- Add or update entries under `profiles`.
- Keep `id` ASCII and stable; put Chinese names in `name`.
- Use `auth.type: password` with `auth.password`, or `auth.type: key` with `auth.keyPath`.
- Keep `note` short and operational, and use `tags` for role/location lookup.
- Update `activeProfile` only when the default target should change.
- After saving the file, call `profiles-reload` in the same conversation to hot-load the change, then call `profiles-list` and confirm `activeProfile`. A startup `--profile` override still wins after reload; to change the default target, use `profiles-use`, or restart without `--profile`.
- If `disableSudo` changes, restart the MCP server because it changes the exposed MCP tool surface.
- `suPassword` is optional. When present, `exec` elevates with `su -c`; `sudoPassword` is only for `sudo-exec`.

Minimal YAML shape:

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
    # suPassword: "${SSH_TEMPLATE_SU_PASSWORD}"  # optional; when set, every exec runs via su -c
    note: "模板维护机，做 cloud-init 和预装验证"
    tags: [template, fi]
```

## Safety Rules

- Never guess the active target. Verify with `profiles-list` before state-changing commands. Use `profiles-test` only to check connectivity. Do not use `profiles-use` to verify — it switches the target and writes the config.
- Do not print or ask the server to echo passwords, private keys, tokens, `.env` values, or expanded secret placeholders.
- For destructive commands, restate the target `id/name/host` and obtain explicit user confirmation before using `exec` or `sudo-exec`.
- For profile deletion, always call `profiles-delete-prepare`, show the returned profile, backup path, and confirmation text to the user, then call `profiles-delete-confirm` only after explicit confirmation.
- Prefer read-only inspection commands before remediation commands when diagnosing a server.
- If a command times out, assume the SSH channel was closed but remote child cleanup may depend on the remote OS and command behavior; inspect before retrying with a broader timeout.

## User-Facing Guidance

If the user asks whether Chinese server names are supported, answer: profile `id` must stay ASCII, but profile `name` can be Chinese.

If the user asks whether config changes can be loaded in the same conversation, answer: yes, save the config and call `profiles-reload`, then confirm with `profiles-list`. Restart only for startup arguments or `disableSudo` changes. If the server was started with `--profile`, reload keeps that override instead of the file's `activeProfile`.

If the user asks whether Ubuntu is supported, answer: yes, the server can SSH into Linux targets such as Ubuntu as long as SSH authentication works and the MCP server itself runs on Node.js 18+.

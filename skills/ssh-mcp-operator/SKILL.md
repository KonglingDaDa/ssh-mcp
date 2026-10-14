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
- `profiles[].name` and `aliases` are human-readable labels and can use Chinese, English, or both. `note` can also use either language, up to 500 characters.
- `buckets` is the directory. A machine belongs to a bucket when one of its `tags` equals that bucket's id, name, or alias. Fine-grained tags stay searchable and are not listed as buckets.
- `profiles-list` returns the current target and bucket counts only. It does not return every machine. Use `profiles-find` to open a bucket or search.
- Secrets should be environment placeholders such as `${SSH_TEMPLATE_PASSWORD}` instead of plaintext when possible.
- `profiles-reload` re-reads the config file in the same MCP session. If the server was started with `--profile=<id>`, reload still prefers that startup override over the file's `activeProfile`. A session-only `profiles-use` is discarded on reload. Restart the MCP server only when startup args or `disableSudo` tool availability change. New tools such as `profiles-bucket-upsert` also require a restart.
- When a profile has `suPassword`, every `exec` runs through `su -c` and is already elevated. `sudo-exec` is only for `sudo`. `activeProfileSummary` includes `elevatedViaSu` (boolean). Search results never return passwords or key paths.

## Command tools

`exec` and `sudo-exec` share these parameters:

- `command` (required): remote shell command
- `description` (optional): client-side only; not sent to the remote shell
- `timeoutMs` (optional): per-command timeout override in milliseconds
- `profileId` (optional): expected target profile id guard. If provided and it does not match `sessionActiveProfile`, the call is rejected with `Target profile mismatch: expected "...", but sessionActiveProfile is "..." (host:port). Call profiles-use first or verify target.`
- `maxOutputChars` (optional): maximum output characters to return (default 64000, max 1000000). Oversized output keeps the first 70% and last 30% with a truncation marker in the middle.

Success and non-zero command errors both start with a target stamp:

```text
[ssh-mcp] target id=<id> name="<name>" host=<host>:<port>
```

If that first line is not the machine the user named, stop.

## Normal Workflow

1. Call `profiles-list` first. Read `sessionActiveProfile` (this conversation/process), `fileActiveProfile` (on-disk default), and the bucket directory. `activeProfile` is the same as `sessionActiveProfile`. This call does not list every machine.
2. If the user names a category, call `profiles-find` with `bucket`. If the user names a machine, call `profiles-find` with `query` and choose by `id`, `name`, `aliases`, `host`, `note`, or `tags`. Never call `profiles-find` with an empty query.
3. Call `profiles-use` with the exact `profileId` only when the user explicitly wants to switch targets. It changes this session only and does not write `activeProfile` to the config file. Never call it just to inspect the current target. To change the file default, edit the config and call `profiles-reload`.
4. Call `profiles-test` before important work on a new, changed, or uncertain target.
5. Use `exec` for ordinary commands when `elevatedViaSu` is false. If `elevatedViaSu` is true, treat every `exec` as already elevated via `su`. Use `sudo-exec` only when `sudo` is required and the tool is available. Pass `profileId` on `exec` / `sudo-exec` whenever the intended machine id is known.
6. Include concise `description` values on command tools so the client log explains intent; the description is not sent to the remote shell.
7. Use `timeoutMs` for long-running commands rather than assuming the default is enough. Use `maxOutputChars` when a command may print a large log.
8. After `profiles-reload` or `profiles-use`, call `profiles-list` again and read `activeProfile` before any state-changing command. Reload discards a session-only `profiles-use` and restores the file default or startup `--profile`.
9. Treat the first line of `exec` / `sudo-exec` output (including failures) as the target stamp (`id`, `name`, `host`). If it is not the machine the user named, stop.

## Adding Or Updating Profiles

Prefer `profiles-create` when the MCP tool is available and the user gives enough target information. It always persists the new profile. `activate` defaults to false (file default and session stay unchanged). `activate: true` switches this session only and still does not write `fileActiveProfile`. To run commands on the new machine after a non-activating create, call `profiles-use`.

When editing `ssh-mcp.profiles.yaml` directly:

- Add or update entries under `profiles`.
- Keep `id` ASCII and stable; put Chinese or English names in `name` and `aliases`.
- Use `auth.type: password` with `auth.password`, or `auth.type: key` with `auth.keyPath`.
- Keep directory buckets few. A profile tag equal to a bucket id, name, or alias places the machine in that bucket. Other tags are keywords only.
- Add or rename a directory bucket with `profiles-bucket-upsert`. Change name, aliases, note, or tags with `profiles-label-update`.
- Update `activeProfile` only when the default target should change.
- After saving the file, call `profiles-reload` in the same conversation to hot-load the change, then call `profiles-list` and confirm `activeProfile`. A startup `--profile` override still wins after reload. `profiles-use` does not change the file default; edit `activeProfile` in the file, then reload, or restart without `--profile`.
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

buckets:
  - id: template
    name: 模板机
    aliases: [template, 模板]

profiles:
  - id: fi-template
    name: 芬兰模板机
    aliases: [Finland template]
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

- Never guess the active target. Verify with `profiles-list` before state-changing commands. Use `profiles-test` only to check connectivity. Do not use `profiles-use` to verify — it switches the session target.
- Pass `profileId` on `exec` / `sudo-exec` as a drift guard when the intended machine is known.
- Do not print or ask the server to echo passwords, private keys, tokens, `.env` values, or expanded secret placeholders.
- For destructive commands, restate the target `id/name/host` and obtain explicit user confirmation before using `exec` or `sudo-exec`.
- For profile deletion, always call `profiles-delete-prepare`, show the returned profile, backup path, and confirmation text to the user, then call `profiles-delete-confirm` only after explicit confirmation.
- Prefer read-only inspection commands before remediation commands when diagnosing a server.
- If a command times out, assume the SSH channel was closed but remote child cleanup may depend on the remote OS and command behavior; inspect before retrying with a broader timeout.

## User-Facing Guidance

If the user asks whether Chinese server names are supported, answer: profile `id` must stay ASCII, but `name`, `aliases`, bucket names, and `note` can be Chinese or English.

If the user asks whether config changes can be loaded in the same conversation, answer: yes, save the config and call `profiles-reload`, then confirm with `profiles-list`. Restart only for startup arguments or `disableSudo` changes. If the server was started with `--profile`, reload keeps that override instead of the file's `activeProfile`.

If the user asks whether Ubuntu is supported, answer: yes, the server can SSH into Linux targets such as Ubuntu as long as SSH authentication works and the MCP server itself runs on Node.js 18+.

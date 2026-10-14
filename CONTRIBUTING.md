# Contributing to ssh-mcp

Thank you for your interest in contributing to ssh-mcp. Please follow these guidelines so reviews stay small and the repo stays safe.

## Local development

1. Fork the repository and create your branch from `main`.
2. Clone your fork and install dependencies with `npm install`.
3. Create a descriptive branch name (e.g. `feature/add-ssh-support` or `bugfix/fix-connection-issue`).
4. Make focused commits. Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`).
5. Run the checks below before opening a Pull Request.

## Test and build commands

- `npm test` — offline unit tests. No Docker and no `127.0.0.1:2222` SSH container. This should pass in about a second.
- `npm run test:docker` — integration tests that need the local SSH container. Start it with `docker compose up -d` first; stop with `docker compose down` when finished.
- `npm run test:smoke` — Testcontainers smoke test (`test/smoke.ssh.test.ts`).
- `npm run build` — compile TypeScript into `build/`. Do not hand-edit `build/`.

GitHub Actions CI runs `npm run build`, `npm test`, then `npm run test:docker` against the workflow `sshd` service.

## Security red lines

Do **not** commit:

- Real server IPs, internal hostnames, or machine codenames
- Passwords, private keys, tokens, or `.npmrc`
- Production profile catalogs with live credentials

Use `*.example.com` hosts and `${ENV_VAR}` placeholders in examples and fixtures. Keep secrets in the environment, never in the repo.

## Pull Requests

- Keep the PR up to date with `main`.
- Describe the behavior change, test evidence (`npm test` / `npm run test:docker` as relevant), and residual risk.
- Reference related issues (e.g. `Closes #12`).
- Be responsive to review comments.

## Code style

- Follow the existing TypeScript ESM style (2-space indent, `kebab-case` files, `camelCase` names).
- Prefer small modules and tests through public interfaces.
- See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

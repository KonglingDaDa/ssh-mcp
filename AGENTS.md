# Repository Guidelines

## 项目结构与模块组织
- `src/` 是核心实现，按职责分层：
  - `src/config/`：配置加载、校验与类型（YAML/JSON profile 目录）
  - `src/profile/`：profile 生命周期；`profile-manager.ts` 管会话目标与持久化，`profile-catalog.ts` 管分桶目录与检索
  - `src/ssh/`：连接与命令执行，含连接保活、断流监听、迟到通道回收
  - `src/tools/`：MCP 工具注册；`exec.ts` / `sudo-exec.ts` 执行层，`profiles.ts` 目录与目标切换，`result.ts` 目标门禁与输出截断
- `docs/INTENT.md`：架构意图与契约（防串台、分桶、连接生命周期）。
- `skills/ssh-mcp-operator/`：给 Agent 用的操作技能。
- `examples/ssh-mcp.profiles.yaml`：示例 profile 目录（仅 `*.example.com` 与 `${ENV_VAR}` 占位）。
- `test/`：Vitest 测试与夹具，`test/fixtures/` 存放本地配置样例。
- `build/`：`tsc` 输出目录，禁止手改。

## 构建、测试与本地运行
- `npm run build`：编译 TypeScript，生成 `build/`。
- `npm test`：离线纯单测，不依赖 Docker / `127.0.0.1:2222`，应秒级全绿。
- `npm run test:docker`：依赖本地 SSH 容器的集成测试。先 `docker compose up -d`（结束后 `docker compose down`）。
- `npm run test:smoke`：`test/smoke.ssh.test.ts`，用 Testcontainers 拉真实 SSH 容器做冒烟。
- `npm run inspect`：使用 MCP Inspector 进行手动验证。

## 编码风格与命名约定
- TypeScript（ESM），缩进 2 空格。
- 文件名 `kebab-case`，变量/函数 `camelCase`。
- 模块保持单一职责，避免大文件堆叠逻辑。

## 测试规范
- 使用 Vitest，测试文件位于 `test/*.test.ts`。
- 配置/逻辑优先写单测；真正连 SSH 的行为放 `test:docker` 或 `test:smoke`。
- 本地跑 `npm run test:docker` 若出现 `ECONNREFUSED 127.0.0.1:2222`，先启动测试容器再重试。

## 提交与 PR 规范
- 提交信息使用 Conventional Commits（如 `feat:`、`fix:`、`chore:`）。
- 行为变更需同步更新 README 与 `docs/INTENT.md`（若触及契约）。
- PR 需写清变更点、测试证据和风险说明。
- 严禁提交真实服务器 IP、内部机器代号、凭据、私钥或 `.npmrc` / token。

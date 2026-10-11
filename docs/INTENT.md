# SSH MCP Server — 架构意图与工程契约 (INTENT)

## 1. 一句话目的
为 AI 编码与运维 Agent 提供**防串台、分桶按需检索、长连接保活、密钥零泄露**的 Profile 驱动型 SSH Model Context Protocol (MCP) 服务端。

## 2. 明确不做（Non-Goals）
- **不做裸参数单机启动**：禁止 `--host / --user / --password` 命令行裸跑，强制通过 `--config=<profiles.yaml>` 统一纳管。
- **不做全量机器倾倒**：`profiles-list` 只返回当前会话目标与分桶目录计数，不一次性返回全部机器卡片，防止撑爆大模型上下文。
- **不做静默跨机执行**：任何目标不匹配、配置热重载后的越权切换或非零退出码均显式返回目标盖章与结构化错误，禁止静默吞错。
- **不做明文凭据回显**：所有工具返回结果与日志严禁回显 `password`、`suPassword`、`sudoPassword` 或私钥正文。

## 3. 可验证成功标准（Success Criteria）
1. **执行层防串台（Target Guard）**：
   - `exec` 与 `sudo-exec` 支持可选参数 `profileId`（显式目标校验/锁定）与 `maxOutputChars`（输出长度保护）：
     - 未传 `profileId` 时在当前 `sessionActiveProfile` 上执行；
     - 传入 `profileId` 且与当前 `sessionActiveProfile` 不一致时，**直接拒绝执行并抛出明确的目标不匹配错误**（提示当前会话目标与期望目标，要求显式调用 `profiles-use` 或核对目标），从根源阻断多任务并发或 `profiles-reload` 后的串台误打！
   - 无论命令成功还是非零退出/报错，返回文本首行均固定盖章 `[ssh-mcp] target id=<id> name="<name>" host=<host>:<port>`。
2. **输出截断保护**：当远端命令输出超过 `maxOutputChars`（默认 `64000` 字符，可通过参数覆盖）时，保留头尾关键输出并附带 `[ssh-mcp] output truncated ...` 标记。
3. **连接层与配置层健壮性**：
   - SSH 连接默认开启 KeepAlive（`keepaliveInterval: 15000`, `keepaliveCountMax: 3`），断线即时感知（`watchClientLoss`），超时迟到通道自动回收（`abandonLateChannel`）。
   - 配置文件写入采用同目录临时文件 + `rename` 原子替换（保留原文件权限）；私钥 `keyPath` 存在性校验改为在真正建立连接或 `profiles-test` 时按需检查，避免单台历史机器缺私钥导致整个服务无法启动。
4. **测试分层与构建闭合**：
   - `npm test` 默认只跑快速单测与集成测试（排除 Docker 容器冒烟 `test/smoke.ssh.test.ts`，几秒内完成）；`npm run test:smoke` 单独跑容器测试；`npm run build` 零报错。

## 4. 状态归属与单向数据流
- **磁盘真源**：`ssh-mcp.profiles.yaml`（含 `activeProfile` 文件默认目标、`buckets` 目录桶、`profiles` 机器列表）。
- **会话状态**：`ProfileManager.activeProfileId`（仅当前 MCP 进程有效，`profiles-use` 修改会话状态，`profiles-reload` 恢复启动 `--profile` 或文件默认）。
- **数据流**：`Tool Call (exec/sudo-exec/profiles-*)` → `ProfileManager (Target Guard & Catalog)` → `SSHConnectionManager (KeepAlive + Channel Guard)` → `Target Stamp & Output Truncator` → `MCP Response`。

## 5. 技术栈与假设日志（Assumptions）
- **技术栈**：Node.js >= 18, TypeScript 5.9, `@modelcontextprotocol/sdk`, `ssh2`, `yaml`, `zod`, `vitest`。
- **假设 1**：`exec({ profileId })` 采用“严格目标门禁（Mismatch Fail-Closed）”而非隐式切换会话目标，因为隐式切换会污染同一会话后续命令的 `sessionActiveProfile`；需要切换时应显式调 `profiles-use`。
- **假设 2**：单次命令输出默认上限设为 `64000` 字符（约 16k tokens），兼顾完整日志排查与 Agent 上下文安全。

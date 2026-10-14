# SSH MCP Server (`ssh-mcp`)

[![NPM Version](https://img.shields.io/npm/v/ssh-mcp)](https://www.npmjs.com/package/ssh-mcp)
[![License](https://img.shields.io/github/license/KonglingDaDa/ssh-mcp)](./LICENSE)
[![Node Version](https://img.shields.io/node/v/ssh-mcp)](https://nodejs.org/)
[![GitHub Stars](https://img.shields.io/github/stars/KonglingDaDa/ssh-mcp?style=social)](https://github.com/KonglingDaDa/ssh-mcp/stargazers)

**SSH MCP Server** 是一个专为 AI Agent（Claude Code、Cursor、Pi、Windsurf 等）生产运维场景设计的 **Profile 驱动型 SSH Model Context Protocol (MCP) 服务端**。

相比传统的“单机裸参数 SSH 工具”，本项目围绕**多机机房管理、防串台安全护栏、低上下文开销与长连接稳定性**进行了深度架构重构，让 AI 在管理数十台生产机、算力机、中转机与 NAS 时既快又稳。

---

## 核心特性

### 1. 防串台双保险（Anti-Drift Target Guard & Target Stamp）
- **显式目标门禁（`profileId` Guard）**：`exec` 与 `sudo-exec` 支持传入 `profileId` 进行目标锁定校验。若当前会话激活机器与传入的 `profileId` 不一致（例如长任务重连、`profiles-reload` 重置或并发穿插），服务端立即拒绝执行并报错拦截，彻底杜绝“命令打错机器”。
- **强制首行目标盖章（Target Stamp）**：每一次命令返回（含成功与非零退出）首行固定输出：
  ```text
  [ssh-mcp] target id=prod-main name="生产主节点" host=198.51.100.10:22
  ```
  且在配置层严格禁止 `id / name / host` 含换行符，防止输出伪造。

### 2. 分桶目录按需检索（Bucketed Catalog）
- **告别全量倾倒**：`profiles-list` 仅返回当前会话目标（`sessionActiveProfile`）、磁盘默认目标（`fileActiveProfile`）与分桶目录计数（如 `生产端`、`显卡机`、`中转`、`客户服务器`），不把几十台机器详情一次性塞进上下文。
- **多维精准检索**：通过 `profiles-find` 按分桶（`bucket`）或中英文关键词（`query`，匹配 `id / name / aliases / host / user / note / tags`）按需展开机器卡片。

### 3. 连接保活与通道防泄漏（Resilient SSH Lifecycle）
- **SSH KeepAlive & 断线即刻感知**：内置连接池复用与心跳保活，底层 Socket 异常断流时立即中止挂起等待，不傻等超时。
- **迟到通道自动回收（Late-Channel Cleanup）**：命令超时触发 `SIGTERM` 并销毁连接后，若远端迟到返回 Channel 流，自动执行关闭回收，绝不误杀后续新建连接。
- **输出截断保护（Output Truncation）**：内置 `maxOutputChars` 保护，防止远端巨量日志打爆 Agent 上下文。

### 4. 安全凭据与原子化持久化（Zero-Leak & Atomic Persistence）
- **密钥零回显**：支持 `${ENV_VAR}` 环境变量占位符展开；任何列表、检索与报错均自动脱敏密码与私钥正文。
- **按需私钥校验**：启动与改配置时不因某台冷备机的私钥路径缺席而阻断全局服务，仅在实际连接或 `profiles-test` 时校验目标机密钥。
- **原子写盘 + 两阶段删机**：配置更新采用同目录临时文件 + `rename` 原子替换；删除机器强制经过 `profiles-delete-prepare`（自动备份 + 生成校验口令）与 `profiles-delete-confirm` 两步确认。

---

## 工具列表（MCP Tools）

| 工具名 | 作用说明 | 关键参数 |
| :--- | :--- | :--- |
| `exec` | 在当前会话目标机上执行 Shell 命令（若配 `suPassword` 则自动通过 `su -c` 提权） | `command`, `profileId?`, `description?`, `timeoutMs?`, `maxOutputChars?` |
| `sudo-exec` | 使用 `sudo` 执行提权命令（自动注入 `sudoPassword` 或走 `sudo -n`） | `command`, `profileId?`, `description?`, `timeoutMs?`, `maxOutputChars?` |
| `profiles-list` | 只读查看当前会话目标、文件默认目标及分桶目录统计 | 无 |
| `profiles-find` | 按目录桶（`bucket`）或中英文关键词（`query`）检索机器卡片 | `query?`, `bucket?`（至少传一项） |
| `profiles-use` | 切换当前 MCP 会话的目标机器（仅会话内生效，不改写磁盘默认） | `profileId` |
| `profiles-test` | 对指定或当前机器执行 TCP、SSH 握手与认证三段式连通性诊断 | `profileId?`, `timeoutMs?`, `retries?` |
| `profiles-reload` | 热重载磁盘配置文件，恢复启动 `--profile` 或文件默认目标 | 无 |
| `profiles-create` | 新增机器档案并持久化（默认不切换当前会话目标，传 `activate: true` 仅切当前会话） | `id`, `name`, `host`, `user`, `authType`, ... |
| `profiles-label-update` | 更新机器显示名、中英文别名（`aliases`）、备注（`note`）或标签（`addTags/removeTags`） | `profileId`, `name?`, `aliases?`, `note?`, ... |
| `profiles-note-update` | 单独更新机器运维备注（最多 500 字） | `profileId`, `note` |
| `profiles-bucket-upsert` | 创建、重命名或移除分桶目录项（移除目录项不会删除机器） | `id`, `name?`, `aliases?`, `note?`, `remove?` |
| `profiles-delete-prepare` | 删除机器第一步：自动备份配置文件并生成确认口令 | `profileId` |
| `profiles-delete-confirm` | 删除机器第二步：凭 `deleteRequestId` 与 `DELETE <profileId>` 执行删除 | `deleteRequestId`, `profileId`, `confirmationText` |

---

## 快速上手

### 1. 安装与构建

```bash
git clone https://github.com/KonglingDaDa/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

### 2. 编写配置文件（`ssh-mcp.profiles.yaml`）

参考 `examples/ssh-mcp.profiles.yaml`：

```yaml
version: 1
activeProfile: prod-main

defaults:
  timeout: 120000
  maxChars: none
  disableSudo: false

buckets:
  - id: production
    name: 生产端
    aliases: [生产, prod, production]
    note: 核心线上机器
  - id: gpu
    name: 算力机
    aliases: [显卡, gpu-cluster, gpu]

profiles:
  - id: prod-main
    name: 生产主节点
    aliases: [主站, US-Prod]
    host: 198.51.100.10
    port: 22
    user: root
    auth:
      type: key
      keyPath: ./keys/prod-main.pem
    note: "核心业务容器宿主机，部署目录 /root/app-prod"
    tags: [production, us]
```

### 3. 接入 MCP 客户端

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "node",
      "args": [
        "/path/to/ssh-mcp/build/index.js",
        "--config=/path/to/ssh-mcp.profiles.yaml"
      ]
    }
  }
}
```

可选启动参数：
- `--config=<path>`（必填）：YAML/JSON 配置文件路径
- `--profile=<id>`（可选）：锁定启动默认激活的机器 ID
- `--timeout=<ms>`（可选）：默认命令超时时间（毫秒，默认 `60000`）
- `--maxChars=<number|none>`（可选）：命令长度上限（默认 `1000`，设为 `none` 不限）
- `--disableSudo`（可选）：彻底隐藏并禁用 `sudo-exec` 工具

---

## 推荐的 Agent 运维工作流

1. **先查目标，不盲打**：调用 `profiles-list` 查看 `sessionActiveProfile` 与分桶目录。
2. **按桶或关键词找机器**：调用 `profiles-find({ bucket: "生产" })` 或 `profiles-find({ query: "198.51.100.10" })` 获取准确 `id`。
3. **显式切机 + 连通性预检**：需换机器时调用 `profiles-use({ profileId })`，关键操作前调用 `profiles-test({ profileId })`。
4. **带 `profileId` 防串台执行**：调用 `exec({ profileId: "prod-main", command: "hostname && whoami && hostname -I", description: "核对生产主节点身份" })`，并核对返回首行 `[ssh-mcp] target` 盖章。

---

## 开发与测试

```bash
# 离线快速单测（不依赖 Docker / 127.0.0.1:2222）
npm test

# 本地 SSH 容器集成测试（先 docker compose up -d）
npm run test:docker

# Testcontainers 冒烟测试
npm run test:smoke

# 编译 TypeScript
npm run build
```

### 项目目录结构

- `src/config/`：profile 配置加载与校验
- `src/profile/`：会话目标、持久化与分桶目录（`profile-manager.ts`、`profile-catalog.ts`）
- `src/ssh/`：SSH 连接、保活、断流监听、迟到通道回收
- `src/tools/`：MCP 工具（`exec` / `sudo-exec` / `profiles-*`，目标门禁与输出截断在 `result.ts`）
- `docs/INTENT.md`：架构意图与契约
- `skills/ssh-mcp-operator/`：Agent 操作技能
- `examples/ssh-mcp.profiles.yaml`：示例配置（`*.example.com` 与环境变量占位）
- `test/`：Vitest 单测、集成测试与夹具

## License

[MIT](./LICENSE) © KonglingDaDa

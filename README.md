# dsh-jj — jj (Jujutsu) 版本控制 DSH 插件

把本机 `jj` CLI 通过零依赖 MCP stdio server 暴露成 DSH 工具（`mcp__jj__*`），
让模型在 jj 仓库里用 jj 语义做版本控制（status / log / diff / describe / new /
commit / edit / abandon / undo / rebase / fetch / push / bookmark / run），
而不是用 git 思维硬套。

## 前置条件

- jj ≥ 0.2x（本机：`/opt/homebrew/bin/jj`，0.39.0），可用 `brew install jujutsu` 安装
- Node ≥ 18（server 零依赖，纯 stdlib）

## 安装

```sh
dsh plugin --profile web add link:/Users/echerlos/syncthing/project/dsfolder/dsh-jj
```

新 bundle 安装后必须重启 dsh web（HMR 只覆盖 config 编辑）：

```sh
~/.dsh/scripts/dsh-web-restart.sh
```

## 验证

```sh
# 1. 配置组合
pnpm dsh --profile web --dump-config | grep mcp-jj

# 2. 插件树 active（fiberPhase）
curl -s -X POST http://127.0.0.1:3080/api/pluginInventory/list \
  -H "Content-Type: application/json" \
  -d '{"type":"client-request","rpcId":"v1","method":"pluginInventory/list","payload":{"args":{}}}' \
  | grep -A2 'mcp-jj'

# 3. 功能：新会话里应出现 mcp__jj__* 工具（已有会话的工具 schema 快照不含新
#    MCP 工具是已知时序行为，以插件树为准）
```

## 工具（serverName `jj` → `mcp__jj__<tool>`）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `jj_status` | 当前 change 摘要 + 工作区改动 | `change` (-r) |
| `jj_log` | change 图（替代 git log） | `limit`/`revset`/`noGraph` |
| `jj_diff` | 当前 change 或指定 change 的 diff | `change`/`files` |
| `jj_describe` | 设置/更新描述（提交信息） | `message`/`change` |
| `jj_new` | 开新空 change（无 add/commit 仪式） | `message`/`base`/`insertBefore` |
| `jj_commit` | 封存当前 change 并开新（describe+new） | `message` |
| `jj_edit` | 跳到已有 change 继续编辑（后代自动 rebase） | `change` |
| `jj_abandon` | 丢弃 change（可 undo） | `change`/`keepDescendants` |
| `jj_undo` | 撤销上一次 jj 操作 | — |
| `jj_rebase` | 移动 change 到新父节点 | `destination`/`source`/`after` |
| `jj_fetch` | git fetch（远程分支→bookmark） | `remote` |
| `jj_push` | 推送 bookmark 到远程 | `bookmark`[]/`deleted`/`all` |
| `jj_bookmark` | bookmark（=git 分支）管理 | `action` create/set/track/untrack/delete/move/list |
| `jj_run` | 通用透传（split/workspace/op restore 等） | `args`[]（禁止 `--config*`） |

所有工具支持可选 `repo` 参数；缺省解析顺序：`repo` 参数 →
`JJ_MCP_DEFAULT_REPO` → 从 server 进程 cwd 向上找 `.jj`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `JJ_MCP_BIN` | `/opt/homebrew/bin/jj`（不存在则 `jj`） | jj 二进制路径 |
| `JJ_MCP_TIMEOUT_MS` | `60000` | 单次调用超时 |
| `JJ_MCP_DEFAULT_REPO` | 空 | 默认仓库目录 |
| `JJ_MCP_LOG` | `1` | `0` 关闭 stderr 启动横幅 |

patch 里已注入 `JJ_MCP_BIN=/opt/homebrew/bin/jj`（本机路径）；换机器改
`cordis.patch.yml` 的 env 即可。

## 安全设计

- 所有工具经 `spawn` 数组参数调 `jj`，无 shell，参数注入免疫；
- `jj_run` 过滤 `--config` / `--config-toml` / `--config-file`（防通过 jj
  配置项如 `ui.editor` 执行任意命令）；
- jj 本身所有操作可 `jj undo` / `jj op restore`，破坏性风险天然低。

## 独立使用（非 DSH）

server 是标准 MCP stdio server，可直接给 Claude Code / Codex 用：

```sh
npx -y jj-mcp  # 或
node /path/to/dsh-jj/server.mjs
```

## 测试

```sh
node test/test-client.mjs /path/to/a/jj/repo     # 完整冒烟套件（真实仓库）
node test/test-client.mjs --list                 # 只列工具
node test/test-client.mjs <repo> --tool jj_log --args '{"limit":5}'
```

测试在仓库上做 new/describe/commit/undo 等操作——用临时仓库
（`jj git init /tmp/jj-test-repo`），别在正式仓库上跑。

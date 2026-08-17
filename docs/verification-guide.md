# 验证指南

> 本文从 dsh-grill-me 插件（设计树拷打 + 会话持久化）的验证历程整理而成。原则：验证在独立 profile / 临时目录上进行，不碰正在运行的实例。

## 验证金字塔总览

自底向上四层，每层通过再进下一层：

1. **离线**：typecheck + build + verify（纯规则、临时目录、自清理）
2. **组合**：`dsh --profile <scratch> --dump-config` 验证 bundle 补丁能组合进配置树（不 boot）
3. **真实端到端**：独立 headless profile + 真实 LLM 任务 + 落盘/事件检查
4. **GUI**：当前版本无 client 面；未来活动面板迭代时按此层补充 ego-browser 验证

## 1. 离线验证

```sh
pnpm typecheck
pnpm build
pnpm verify
```

覆盖内容：

- `verify.mjs`：打包契约（patch name == package name、files 含 lib/patch、publishConfig public、peer 全 optional）、frontier 计算、前置门禁、冻结语义、settle/archive 迁移、session.json 往返与归档。
- `lifecycle-verify.mjs`：用编译后的工具定义驱动完整生命周期，断言会话事件；并验证 `/grill-me` 命令注册（commands 服务存在/缺席）、steer 载荷为字面命令行、裸命令行为与 dispose 清理。
- `stress-verify.mjs`：确定性并发与隔离矩阵（重复 begin、未知会话、双会话隔离、并发回答、迟到写入、重复 archive）。
- `verify:skill`：skill 镜像一致。

## 2. 组合验证

```sh
dsh plugin --profile headless add /path/to/grill-me
dsh --profile headless --dump-config | grep "id: grill-me"
```

- `--dump-config` 离线组合，不 boot 服务、不动运行实例。
- 输出应出现 `- id: grill-me` 与 `config`。

## 3. 真实端到端

```sh
mkdir -p /tmp/grill-me-e2e && cd /tmp/grill-me-e2e
dsh --profile headless "/grill-me 用户想做一个'智能体系统'"
```

判定成功：

- `.grill-me/<sessionId>/session.json` 存在且含设计树；
- 会话日志含 `tool/call` 的 `grill_*` 工具调用（`grill-me/*` 会话事件为尽力而为）；
- 最终有 settled 边界规格（或按协议明确归档）。

> headless 无命令拦截，模型直接按协议段解析字面 `/grill-me` 行；web profile 则由命令 handler 拦截并 steer 同一行，行为一致。

仓库级自动化：`.github/workflows/e2e.yml` 在配置 `DEEPSEEK_API_KEY` secret 后于 PR/手动触发时执行；无 key 自动跳过。

## 4. GUI（预留）

当前版本无浏览器面。未来增加活动面板时，按 dsh-agent-teams 的方式补充：独立 web profile + ego-browser、DOM 探针 `data-*`、截图存档、宽窄屏与 reduced-motion。

## 验证清单模板

```markdown
## 验证清单：grill-me

### 构建与离线
- [ ] pnpm typecheck
- [ ] pnpm build
- [ ] pnpm verify
- [ ] git diff --check

### 组合
- [ ] dsh plugin --profile headless add .
- [ ] dsh --profile headless --dump-config | grep "id: grill-me"

### 真实端到端（需 DEEPSEEK_API_KEY）
- [ ] 独立目录跑 headless 任务
- [ ] .grill-me/session.json 落盘
- [ ] 会话日志含 grill_* 工具与 grill-me/* 事件
- [ ] 有 settled boundary（或按协议归档）
```
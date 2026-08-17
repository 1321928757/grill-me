# 从零开发一个 DeepSeek Harness（DSH）插件

> 本文是 dsh-grill-me 插件（host 工具 + system prompt 协议段 + 文件持久化）开发过程的经验蒸馏，供 coding agent 直接照做。
> 参考实现：`dsh-grill-me`（成品）、DSH 仓库 `packages/workflow/tool-workflow`（工具插件模板）。

## 0. 全景：一个 DSH bundle 插件是什么

一个可安装插件 = 一个 npm 包，作为组合树里的一行插件挂载，注册工具、system prompt 段、服务、HTTP 路由与会话事件。

安装 = `dsh plugin --profile <profile> add <包路径或包名>`：pnpm 装进 profile，并把包加入 profile manifest 的 `dsh.profile.bundles` 层列表；bundle 的 `cordis.patch.yml` 作为补丁层把插件行插进组合树。plugin add 后需要重启该 profile。

## 1. 插件形态与项目骨架

```
dsh-my-plugin/
├── package.json          # dsh.bundle + exports + files
├── cordis.patch.yml      # 向 host 组合插入插件行
├── tsconfig.json         # host 编译
├── src/
│   ├── index.ts          # name / inject / Config / apply
│   ├── tools.ts          # 工具注册
│   ├── state.ts          # 文件持久化与纯规则
│   ├── types.ts          # 领域类型
│   └── event-types.ts    # SessionEventMap 合并（零 import）
├── scripts/verify.mjs    # 离线冒烟验证
└── .github/workflows/    # CI / 发布
```

### 1.1 package.json 要素

```jsonc
{
  "name": "dsh-my-plugin",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- `exports["./cordis.patch.yml"]` 与 `files` 必须存在，否则安装后 patch 找不到。
- peerDependencies 全部 optional，避免独立 profile 安装时 pnpm 告警。
- `publishConfig.access: "public"`，scope 包才能公开发布。

### 1.2 cordis.patch.yml：一行插件进组合

```yaml
- insert:
    - id: my-plugin
      name: dsh-my-plugin
      config:
        stateDir: .my-state
```

`name` 必须等于包名，`id` 是配置树中的稳定行身份。

### 1.3 tsconfig

```jsonc
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "declarationDir": "lib/types",
    "outDir": "lib",
    "rootDir": "src",
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

只有 host 面时，一个 program 足够；有 client 面时必须拆 host/client 两个 program（见 DSH 官方 `ui-message-feedback` 模板）。

## 2. Host 侧开发

### 2.1 函数插件四要素

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'my-plugin'
export const inject = ['tools', 'systemPrompt']
export interface Config { stateDir?: string }
export const Config: z<Config> = z.object({ stateDir: z.string().default('.my-state') })
export function apply(ctx: Context, config: Config): void { ... }
```

- `import type {} from '<包>'` 是声明合并触发器，让 `ctx.tools` / `ctx.systemPrompt` 类型可见。
- Config 默认值放 schema，部署可调项进配置，不写源码常量。

### 2.2 工具注册（defineTool）

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'my_tool',
  description: '……模型看到的完整契约……',
  parameters: { arg: { type: 'string', required: true, description: '……' } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    const workspace = exec.agent?.session.header.cwd
    if (!workspace) throw new Error('requires a calling agent with a workspace')
    return { ok: true }
  },
}))
```

关键经验：

- `exec.agent.session.header.cwd` 是调用者工作区，是插件状态落盘的位置。
- 工具返回值必须是 DSH 的 `JsonValue`；接口数组要显式转成 `{ [key: string]: JsonValue }`，否则 tsc 报 index signature 错误。
- `description` 就是模型契约：写清前置条件、失败语义、副作用。
- provider/兄弟插件注册可能晚于本插件 apply，依赖兄弟行为的校验要延迟到首次使用时（fail-loud 最早可解析点）。

### 2.3 system prompt 协议段

```ts
ctx.systemPrompt.section({
  name: 'my-plugin:usage',
  order: 118,
  text: '……模型必须遵守的协议……',
})
```

协议段是模型可见的行为契约；工具是执行手段，协议段负责“何时用、怎么用、不许猜”。

### 2.4 状态持久化

- 状态真相源是文件：`<workspace>/<stateDir>/<sessionId>/session.json`。
- 同一会话读-改-写必须串行化：进程内 promise 链互斥。
- 新建用 `flag: 'wx'` no-clobber；更新用同目录临时文件 + rename 原子发布。
- 归档用 rename 到 `<stateRoot>/archive/`，历史完整保留。
- 事件/模型可能绕过工具仪式，持久化状态要能被独立读取并作为真相。

### 2.5 会话事件（审计/重放）

`event-types.ts` 必须零 import：

```ts
export interface MyEventData { readonly sessionId: string }
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'my-plugin/event': MyEventData }
}
```

发射处用 `session.append(type, data)`；append 是泛型方法，跨边界调用时做受控类型转换并 try/catch 降级。

## 3. 验证

### 3.1 离线

```sh
pnpm typecheck
pnpm build
pnpm verify
```

- 纯规则：状态迁移、frontier、门禁——从 `lib/` 导入纯函数断言。
- 生命周期：驱动编译后的工具定义，走完整流程并断言事件。
- 并发/隔离：重复创建、未知会话、跨会话隔离、并发写、迟到写、重复归档。
- 打包契约：patch name == package name、files 含 lib/patch、publishConfig public、peer optional。

### 3.2 组合

```sh
dsh plugin --profile headless add .
dsh --profile headless --dump-config | grep "id: my-plugin"
```

### 3.3 真实端到端

```sh
dsh --profile headless "一个小而可判定的任务，明确要求走插件协议"
```

核对落盘状态与会话事件流；任务要小、明确点名工具与顺序，否则模型可能跳过。

## 4. 完成标准

- manifest、exports、patch 与产物一致；`name` 全仓库唯一。
- 工具、prompt 段、路由、持久化均可清理/可复核。
- typecheck、build、verify、组合验证、真实 e2e（配置 key 后）通过。
- README 安装命令与真实分发形态一致。
# grill-with-docs 能力设计与落地说明

> 本文档把 grill-with-docs 技能（源自 `~/.codex/skills/mattskills/` 的 grill-with-docs，及其依赖的 grilling 与 domain-modeling 技能）的能力提取、设计并落地到 dsh-grill-me 插件。它是实现 grill-with-docs 功能前的设计说明，也是实现后的维护参考。

## 1. 能力来源

| 来源 | 路径 | 内容 |
| --- | --- | --- |
| grill-with-docs | `engineering/grill-with-docs/` | 薄包装：运行 grilling 会话，同时使用 domain-modeling |
| grilling | `productivity/grilling/` | 设计树 frontier 拷打：一轮问完前置已决的问题，每题编号 + 推荐答案 |
| domain-modeling | `engineering/domain-modeling/` | 拷打过程中同步沉淀领域模型：CONTEXT.md 术语表 + docs/adr/ 架构决策 |

grill-with-docs 的组合语义：**拷打设计的同时，把术语与架构决策写下来**——术语结晶即更新 `CONTEXT.md`，值得记录的架构决策进 `docs/adr/`，二者都在会话过程中内联完成，不批量、不事后补。

## 2. 落地形态（并入 grill-me 插件）

- **同一包内新能力**：不新建独立 npm 包，作为 dsh-grill-me 的新命令与新工具族。
- **命令**：新增 `/grill-with-docs` 宿主命令，与 `/grill-me` 共用设计树/卡片/settle 基建；`/grill-me` 纯拷打行为保持不变。
- **配置**：`docsEnabled`（默认 `true`）控制 `/grill-with-docs` 是否沉淀文档；`docsDir`（默认 `''` = 工作区根）覆盖文档落点目录。
- **工具族**：`grill_docs_read`（读现状）+ `grill_docs_update`（写术语/ADR），模型在拷打过程中调用落盘。

## 3. 文档结构（遵循原版约定）

### 3.1 单上下文（默认）

```
<workspace>/
├── CONTEXT.md          # 术语表（glossary），仅术语，无实现细节
└── docs/
    └── adr/
        ├── 0001-<slug>.md
        └── 0002-<slug>.md
```

### 3.2 多上下文（检测到 CONTEXT-MAP.md 时）

```
<workspace>/
├── CONTEXT-MAP.md       # 上下文清单与关系
├── docs/adr/            # 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md   # 上下文自己的术语表
    │   └── docs/adr/    # 上下文级决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

规则：`CONTEXT-MAP.md` 存在则按多上下文；只有根 `CONTEXT.md` 则单上下文；都没有则惰性创建根 `CONTEXT.md`。当前话题归属不明确时询问用户。

### 3.3 惰性创建

- 第一个术语结晶时才创建 `CONTEXT.md`（或对应上下文的 `CONTEXT.md`）。
- 第一个 ADR 需要时才创建 `docs/adr/`。
- 不预建空文件。

## 4. CONTEXT.md 术语表约定（CONTEXT-FORMAT）

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request
```

规则：

- **Opinionated**：同一概念多个词时选最佳词，其余列 `_Avoid_`。
- **定义紧凑**：一两句，定义"是什么"而非"做什么"。
- **只收项目特有术语**：通用编程概念（timeout、error types 等）不收。
- **可分组**：自然聚簇时用子标题分组；单一聚簇用平铺列表。
- **无实现细节**：CONTEXT.md 是术语表，不是 spec、草稿或实现决策仓库。

## 5. ADR 约定（ADR-FORMAT）

模板（可单段，价值在记录"做了决定 + 为什么"）：

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

可选节（仅当有真实价值）：

- **Status** frontmatter（`proposed | accepted | deprecated | superseded by ADR-NNNN`）
- **Considered Options**（被否备选值得记住时）
- **Consequences**（非显然的下游影响需要点出时）

编号：扫描 `docs/adr/` 最高编号 +1，格式 `0001-slug.md`。

### 5.1 何时提供 ADR（三条件全真才提供）

1. **难逆转**——日后改主意成本可观；
2. **无上下文会惊讶**——未来读者会问"为什么这么做"；
3. **真实权衡**——存在真实备选，因具体理由选了一个。

三者缺一即跳过。符合的例子：架构形态、上下文间集成模式、带锁定的技术选型、边界与范围决策、对明显路径的刻意偏离、代码不可见的约束、非显然的被否备选。

## 6. 会话中的文档纪律（协议要求）

- **挑战冲突术语**：用户用词与 CONTEXT.md 既有语言冲突时立即指出。
- **锐化模糊语言**：用户用模糊/过载词时提议精确规范词。
- **具体场景压力测试**：讨论领域关系时用具体场景探测边界。
- **与代码交叉引用**：用户陈述工作方式时核对代码，矛盾就指出。
- **内联更新**：术语结晶即写 CONTEXT.md，不批量。
- **克制提供 ADR**：三条件全真才提供。

## 7. 工具契约（grill_docs 工具族）

### grill_docs_read

读当前文档现状，供模型在拷打中查询已有术语/决策，避免重复与冲突。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `session_id` | string, required | grill 会话 id（校验会话存在且 open） |
| `scope` | string | 可选：`context`（读术语表）/ `adr`（列 ADR）/ `map`（读 CONTEXT-MAP.md）/ `all`（默认） |

返回：工作区根、docsDir 解析结果、单/多上下文判定、CONTEXT.md 与 CONTEXT-MAP.md 内容（存在时）、docs/adr/ 列表与最高编号。

### grill_docs_update

写术语或 ADR，落盘即真相源。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `session_id` | string, required | grill 会话 id |
| `kind` | string, required | `term` 或 `adr` |
| `context` | string | 多上下文时目标上下文路径（如 `src/ordering`）；单上下文可省 |
| `term` | string | kind=term 时术语名 |
| `definition` | string | kind=term 时定义（一两句） |
| `avoid` | string[] | kind=term 时 `_Avoid_` 列表 |
| `section` | string | kind=term 时可选分组标题 |
| `title` | string | kind=adr 时决策标题（生成 `000N-slug` 文件名） |
| `body` | string | kind=adr 时 1-3 句正文 |
| `status` | string | kind=adr 时可选 frontmatter status |
| `considered` | string[] | kind=adr 时可选被否备选 |
| `consequences` | string | kind=adr 时可选后果 |

行为：

- `term`：读取（或惰性创建）目标 `CONTEXT.md`，按 CONTEXT-FORMAT 更新 `## Language` 节；同名术语覆盖其定义与 `_Avoid_`，`_Avoid_` 与既有定义冲突时返回冲突提示由协议处理（挑战术语）。
- `adr`：扫描 `docs/adr/` 最高编号 +1，写 `000N-<slug>.md`；slug 由 title 折叠生成（sanitize 规则复用 `sanitizeKey` 思路）。
- 所有写入经事件 `grill-me/docs-updated` 记录（kind/path/scope），磁盘为真相源。

## 8. 验证

- 纯规则：CONTEXT-FORMAT 生成/更新、ADR 编号递增、多上下文判定、惰性创建、sanitize 冲突。
- 落盘：临时目录下 CONTEXT.md / docs/adr/ 往返与更新。
- 工具生命周期：grill_docs_read / grill_docs_update 经编译后定义驱动，断言事件与落盘。
- 命令：`/grill-with-docs` 注册、steer 载荷、`/grill-me` 不受影响。
- 真实 e2e：headless `/grill-with-docs <query>`，核对 CONTEXT.md / docs/adr/ 与 `.grill-me/` 落盘。

## 9. 不做

- 不修改原版技能文件（只读提取）。
- 不改动 `/grill-me` 纯拷打协议行为。
- 不实现 GUI/浏览器面。
- 不新建独立 npm 包。

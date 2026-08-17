# dsh-grill-me

Grill the user through design-tree frontier rounds until a query's boundaries are explicit, then proceed.

`dsh-grill-me` is a DeepSeek Harness plugin: the user invokes `/grill-me` (the only entry — there is no automatic trigger), and the agent then builds a design tree, asks the whole frontier in one round with recommended answers, and only executes after the user confirms an explicit boundary spec.

## Why grill-me?

| Capability | What it changes |
| --- | --- |
| Design tree | Every decision is a node; answers unlock dependent decisions, leaving no hidden assumptions |
| Frontier rounds | Only ask decisions whose prerequisites are settled, all in one round, each with a recommendation |
| Self-served facts | The agent looks up what it can from the environment; only decisions belong to the user |
| Boundary spec | Once the frontier is empty and the user confirms, the agent settles an explicit boundary before acting |
| Persistence and audit | Trees persist under `.grill-me/`; archives keep full history; session events replay |

## How it works

`dsh-grill-me` reuses DSH capability seams instead of inventing a workflow engine:

| DSH capability | grill-me usage |
| --- | --- |
| `ctx.tools` registry | Registers 6 `grill_*` tools |
| `ctx.systemPrompt.section()` | Registers the "grill-me:usage" protocol section |
| `ctx.commands` registry | Registers the `/grill-me` host command (visible in the GUI "/" menu, intercepted by the client) |
| Filesystem | State persists at `<workspace>/.grill-me/<sessionId>/session.json` |

Data flow: tool execution → disk state (source of truth) → session log events (audit/replay).

## Tool reference

| Tool | Purpose |
| --- | --- |
| `grill_begin` | Start a design-tree session for one query |
| `grill_question` | Add a decision; it enters the frontier once prerequisites are settled |
| `grill_answer` | Record the user answer, freeze the decision, expand the frontier |
| `grill_frontier` | Inspect the tree, frontier, settled decisions, and boundary status |
| `grill_settle` | Freeze the boundary spec once the frontier is empty and the user confirms |
| `grill_archive` | Close and archive the session, keeping the full design tree |

## Install

> Requires an existing [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

```sh
dsh plugin --profile web add @nanmicoder/dsh-grill-me
```

Build from source:

```sh
git clone https://github.com/shironghe/grill-me.git
cd grill-me
pnpm install
pnpm build
dsh plugin --profile web add .
```

Validate the composed profile, restart DSH, and refresh the Web UI:

```sh
dsh --profile web --dump-config
dsh web
```

## Configuration

Defaults work without extra setup:

```yaml
- id: grill-me
  config:
    stateDir: .grill-me
```

`stateDir` names the state directory under the workspace.

## Command

`/grill-me` is the only entry to grilling; vague queries are never grilled automatically.

| Usage | Meaning |
| --- | --- |
| `/grill-me <query>` | Force the full design-tree workflow on that query (mandatory even when it looks crisp) |
| `/grill-me` (bare) | Force-grill the user's most recent substantive request in the conversation |

In the web GUI the command is intercepted by the client (visible in the "/" menu, `command/run` logs the args); the handler steers the literal command line back to the agent, which runs the `grill_*` tools. In headless/CLI the un-intercepted `/grill-me` line is handled by the same prompt protocol.

## Protocol

1. After the user invokes `/grill-me [query]`, the agent must call `grill_begin` and build a design tree; it may not skip grilling because the query looks crisp.
2. Each round asks the whole frontier at once, with a recommended answer per question; never ask questions whose prerequisites are still open.
3. Answers are recorded with `grill_answer`, freezing decisions and expanding the frontier.
4. Facts are the agent's job; only decisions belong to the user.
5. When the frontier is empty and the user confirms, the agent calls `grill_settle` with an explicit boundary; nothing executes before the boundary is settled.
6. After execution, the agent calls `grill_archive` to keep the full tree.

## Verification

```sh
pnpm typecheck
pnpm build
pnpm verify
```

The matrix covers packaging contract, pure design-tree rules, tool lifecycle, concurrency/isolation, and skill mirror sync. Real e2e needs the DSH CLI and `DEEPSEEK_API_KEY`; see [docs/verification-guide.md](./docs/verification-guide.md).

## Known limits

- One query maps to one session; archive the old session before starting the same query again.
- State is file-backed and serialized within one DSH process; concurrent processes editing the same session are not coordinated.
- Models may skip tool ceremony (forgetting `grill_settle`); treat `grill_frontier` / persisted state as truth.
- Free private repositories cannot use GitHub branch protection; making the repo public enables it.

## Documentation

| Guide | Covers |
| --- | --- |
| [Usage](./docs/usage.md) | Architecture, tools, protocol, configuration, limits, validation |
| [Verification](./docs/verification-guide.md) | Offline, composition, real e2e, and checklists |
| [Implementation](./docs/implementation.md) | How grill-me is implemented and maintained |
| [AI pipeline](./docs/ai-pipeline.md) | Human-review-only workflow |

## Development

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm verify
```

## License

[MIT](./LICENSE)
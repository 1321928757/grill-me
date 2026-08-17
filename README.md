# dsh-grill-me

Grill the user through design-tree frontier rounds until a query's boundaries are explicit, then proceed.

`dsh-grill-me` is a DeepSeek Harness plugin: the user invokes `/grill-me` (the only entry — there is no automatic trigger), and the agent then builds a design tree, asks the whole frontier in one round through `grill_ask` rendered as DSH question cards with recommended answers, and only executes after the user confirms an explicit boundary spec.

## Why grill-me?

| Capability | What it changes |
| --- | --- |
| Design tree | Every decision is a node; answers unlock dependent decisions, leaving no hidden assumptions |
| Question cards | Every frontier round and the settle confirmation are forced through the DSH Web GUI question-card UI; plain-text questions are gone |
| Frontier rounds | Only ask decisions whose prerequisites are settled, all in one round, each with a recommended answer marked 推荐 |
| Self-served facts | The agent looks up what it can from the environment; only decisions belong to the user |
| Boundary spec | Once the frontier is empty and the user confirms, the agent settles an explicit boundary before acting |
| Persistence and audit | Trees persist under `.grill-me/`; archives keep full history; session events replay |

## How it works

`dsh-grill-me` reuses DSH capability seams instead of inventing a workflow engine:

| DSH capability | grill-me usage |
| --- | --- |
| `ctx.tools` registry | Registers 7 `grill_*` tools |
| `ctx.userQuestions` | `grill_ask` renders the Web GUI question cards through it and writes answers back into the design tree |
| `ctx.systemPrompt.section()` | Registers the "grill-me:usage" protocol section (mandating card-based questions) |
| `ctx.commands` registry | Registers the `/grill-me` host command (visible in the GUI "/" menu, intercepted by the client) |
| Filesystem | State persists at `<workspace>/.grill-me/<sessionId>/session.json` |

Data flow: tool execution → disk state (source of truth) → session log events (audit/replay).

## Tool reference

| Tool | Purpose |
| --- | --- |
| `grill_begin` | Start a design-tree session for one query |
| `grill_question` | Add a decision; it enters the frontier once prerequisites are settled (optionally with 2-4 `options` for a multi-option card) |
| `grill_ask` | Render the whole frontier as question cards and record answers automatically; with an empty frontier, render the settle-confirmation card (approval freezes the boundary) |
| `grill_answer` | Record the user answer, freeze the decision, expand the frontier (text-fallback rounds) |
| `grill_frontier` | Inspect the tree, frontier, settled decisions, and boundary status |
| `grill_settle` | Freeze the boundary spec once the frontier is empty and the user confirms (text-fallback path) |
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
2. Each round calls `grill_ask` to render the whole frontier as DSH question cards (question id = decision id, 2-4 options with the recommended answer first and marked 推荐, custom-answer field, skip support); the card is the ONLY allowed question presentation — never plain text.
3. `grill_ask` records answers into the design tree automatically and returns the next frontier; never ask questions whose prerequisites are still open.
4. Facts are the agent's job; only decisions belong to the user.
5. When the frontier is empty, the agent writes the explicit boundary spec and calls `grill_ask` again with the `boundary` — it renders a settle-confirmation card; nothing executes until the user approves and the boundary is frozen.
6. After execution, the agent calls `grill_archive` to keep the full tree.
7. In environments without a question-card UI (headless CLI), `grill_ask` fails with a `user-questions-unavailable` error; fall back to plain-text questions and record answers with `grill_answer` / `grill_settle`.

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
- Question cards require the `ctx.userQuestions` capability (composed by the DSH base bundle) and a Web GUI UI provider; headless environments fall back to text (protocol step 7).
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
# dsh-grill-me

一句话，让模糊 query 先过拷打，再动手。

`dsh-grill-me` 是 DeepSeek Harness 插件：当请求边界不清时，agent 把需求建成设计树，每轮把 frontier 问题一次问完并给出推荐答案，直到用户确认边界规格。

## 安装

```sh
dsh plugin --profile web add @nanmicoder/dsh-grill-me
```

## 开发

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm verify
```

详细见 docs/usage.md 与 docs/verification-guide.md。
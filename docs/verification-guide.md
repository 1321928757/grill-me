# grill-me 验证指南

## 离线

```sh
pnpm typecheck
pnpm build
pnpm verify
```

verify 覆盖打包契约、设计树纯规则、session.json 落盘/归档。

## 组合

```sh
dsh plugin --profile headless add /path/to/grill-me
dsh --profile headless --dump-config | grep "id: grill-me"
```

## 真实端到端

```sh
mkdir -p /tmp/grill-me-e2e && cd /tmp/grill-me-e2e
dsh --profile headless "用户想做一个'智能体系统'。先用 grill-me 拷打边界，再输出明确需求"
```

核对：

- `.grill-me/<sessionId>/session.json` 存在且含设计树；
- 会话日志含 `grill_*` 工具调用事件；
- 最终有 settled 边界规格。
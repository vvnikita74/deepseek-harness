---
kind: upgrade-guide
description: "Web 配置文件移除 `--no-open`、`openBrowser` 配置与 `webStartup` 值，以及默认浏览器交接；访问 URL 现在在重启后保持不变。"
---

# Web 配置文件不再打开浏览器

[English](guide.md) | 中文

## 变更

`dsh --profile web` 不再打开默认浏览器。`--no-open` 标志已移除，传入它的命令或脚本会在服务启动前以 `unknown option '--no-open'` 退出。`web-runtime` 行的 `openBrowser` 键与 `ctx.webStartup` 的 `openBrowser` 字段已移除；读取 `ctx.webStartup.openBrowser` 的表达式或 patch 会求值失败。

`dsh web:` URL 行仍会打印。其访问密钥现在是持久的：首次生成后保存在 `client-connection/access-key` 凭据记录中，之后每次启动复用，因此收藏的 URL 仍然有效。删除该记录并重启 `dsh` 会轮换密钥，旧 URL 失效。

新增的 `--allowed-origin <origin...>`（可重复）标志与 `client-connection` 的 `allowedOrigins` 配置是增量的：它们允许独立托管的前端等精确跨源浏览器客户端访问。

## 迁移

1. 从每个 `dsh --profile web`、`dsh web`、`make web` 的 `ARGS=` 以及 `pnpm run dev:web` 调用与脚本中删除 `--no-open`。
2. 从 patch 或 overlay 的每个 `web-runtime` 行配置中删除 `openBrowser`，并删除读取 `ctx.webStartup.openBrowser` 的表达式。patch 会替换该行的整个 `config`，因此需重新写出其余键。
3. 若需从启动器打开 GUI，请读取服务器打印的 `dsh web:` 行并自行打开该 URL。
4. 用 `dsh --profile web --dump-config` 确认：组合后的 `web-runtime` 配置不含 `openBrowser` 键，启动时打印 `dsh web:` 行。

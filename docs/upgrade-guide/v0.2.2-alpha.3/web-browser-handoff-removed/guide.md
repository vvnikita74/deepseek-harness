---
kind: upgrade-guide
description: "The Web profile drops `--no-open`, the `openBrowser` config and `webStartup` value, and the default-browser handoff, and its access URL now stays the same across restarts."
---

# Web profile no longer opens a browser

English | [中文](guide.zh.md)

## Change

`dsh --profile web` no longer opens the default browser. The `--no-open` flag is removed, so a command or script that passes it now stops with `unknown option '--no-open'` before the server starts. The `openBrowser` key of the `web-runtime` row and the `openBrowser` field of `ctx.webStartup` are removed; an expression or patch that reads `ctx.webStartup.openBrowser` fails to evaluate.

The `dsh web:` URL line still prints. Its access key is now persistent: it is created once in the `client-connection/access-key` credential record and reused on every start, so a bookmarked URL keeps working. Deleting that record and restarting `dsh` rotates the key and invalidates the old URL.

The new `--allowed-origin <origin...>` flag (repeatable) and the `allowedOrigins` config of `client-connection` are additive: they admit exact cross-origin browser clients such as a separately hosted frontend.

## Migration

1. Remove `--no-open` from every `dsh --profile web`, `dsh web`, `make web` `ARGS=`, and `pnpm run dev:web` invocation and script.
2. Remove `openBrowser` from every `web-runtime` row config in your patch or overlay, and remove any expression that reads `ctx.webStartup.openBrowser`. A patch replaces the row's whole `config`, so restate the remaining keys.
3. To open the GUI from a launcher, read the `dsh web:` line the server prints and open that URL yourself.
4. Confirm with `dsh --profile web --dump-config`: the composed `web-runtime` config has no `openBrowser` key, and boot prints a `dsh web:` line.

# Codex Web

在 macOS 或 Windows 上用浏览器管理本机 Codex。

Codex Web 在运行 Codex 的电脑上启动一个 Bun 服务。macOS 连接 Codex 原生 daemon；Windows 由项目管理一个仅监听回环地址的共享 `codex app-server`。通过配套脚本启动的 CLI 和 Web 可以连接同一个 app-server；浏览器始终只连接 Codex Web，不直接接触原始 app-server 协议。

> 这是一个非官方项目，与 OpenAI 没有关联。当前版本面向个人使用，Linux 和 WSL 暂不支持。

## 功能

- 新建任务，或在 Web 中实时继续兼容的 CLI 任务
- 按任务查看模型并调整思考强度、权限配置
- 浏览运行 Codex Web 那台电脑上的项目目录
- 查看回答、命令、文件变更、结构化 diff、计划和运行状态
- 对未提交变更发起内联 Code Review
- 在网页中处理 Codex 的审批请求
- 上传文本、源码、PDF 和图片作为单次消息的上下文
- 同一套 Web UI 支持原生 macOS 和 Windows
- 可通过 Cloudflare Tunnel + Cloudflare Access 安全地远程访问

## 运行要求

- 原生 macOS 或 Windows
- [Bun](https://bun.sh/) 1.3 或更高版本
- 已安装并登录 Codex CLI
- Codex 命令位于 `PATH`，或通过 `CODEX_WEB_CODEX_EXECUTABLE` 指定绝对路径

先确认下面两个命令可用：

```sh
bun --version
codex --version
```

## 快速开始

克隆仓库并安装依赖：

```sh
git clone https://github.com/yangyu370/codex-web.git
cd codex-web
bun install
```

### macOS

```sh
./scripts/start-macos.sh
```

### Windows

在 PowerShell 中运行：

```powershell
.\scripts\start-windows.ps1
```

需要让新的 Windows CLI 任务与 Web 实时互通时，用项目提供的包装脚本启动 Codex：

```powershell
.\scripts\codex-web-cli.ps1
```

Codex 的原有参数可以直接放在后面，例如：

```powershell
.\scripts\codex-web-cli.ps1 resume --last
```

包装脚本会确认共享 app-server 已就绪，再把经过校验的本地 endpoint 交给 `codex --remote`。它不会改写 Codex 配置、Shell Profile 或 `PATH`。为避免 endpoint 被替换，不能自行传入 `--remote` 或 `--remote-auth-token-env`。

启动完成后访问 [http://127.0.0.1:4173](http://127.0.0.1:4173)。启动脚本会先构建前端，再启动服务；它不会安装或升级 Bun、Codex，也不会修改现有的 `CODEX_HOME`。

### CLI 与 Web 实时接管

Windows 的包装脚本和 Codex Web 都会按需启动同一个共享 app-server，因此 CLI-first 和 Web-first 都可以：

```text
CLI-first: codex-web-cli.ps1 → 稍后启动 Codex Web → 选择 LIVE · CLI 任务
Web-first: Codex Web → codex-web-cli.ps1 → 选择 LIVE · CLI 任务
```

Windows 共享模式要求 `codex-cli 0.149.1` 或更高版本；更旧的版本会在 `auto` 下退回私有 app-server，在 `required` 下直接报告不兼容。

Web 会在窗口重新获得焦点时刷新任务目录，并持续接收共享会话事件。Web、CLI 中任一端均可继续输入、处理中断和审批；已被另一端处理的审批会作为正常同步竞争刷新，不会显示成致命错误。

平台实现：

- macOS：保留 Codex 原生 daemon，不在 Web 项目里复制进程协调逻辑。
- Windows：默认自动复用或启动项目管理的共享 TCP app-server；共享启动失败时可以退回 Web 私有的 app-server。
- 通过 `codex-web-cli.ps1` 启动并成功连接共享 app-server 的任务：CLI 与 Web 均可继续输入、处理中断和审批。
- 直接运行普通 `codex`、Codex Desktop 或其他私有 writer 创建的任务：writer 存活时 Web 显示 `READ ONLY · LOCAL CLI`，每三秒刷新历史；关闭原客户端后可再次选择任务尝试取得读写权限。

任务的权限和思考强度来自 Codex 原生元数据。运行中的修改从下一回合生效；Web 只把成功选择保存为新任务默认值，不覆盖 Codex 的全局配置。

如果 Codex 不在 `PATH` 中，可以手动指定：

```sh
CODEX_WEB_CODEX_EXECUTABLE=/absolute/path/to/codex ./scripts/start-macos.sh
```

```powershell
$env:CODEX_WEB_CODEX_EXECUTABLE = 'C:\absolute\path\to\codex.exe'
.\scripts\start-windows.ps1
```

### Windows 共享 app-server 管理

可单独查看或管理共享进程：

```powershell
.\scripts\windows-shared-app-server.ps1 start
.\scripts\windows-shared-app-server.ps1 status
.\scripts\windows-shared-app-server.ps1 restart
.\scripts\windows-shared-app-server.ps1 stop
```

生命周期文件按 `CODEX_HOME` 隔离。`stop` 和 `restart` 会核对 endpoint、进程租约和 generation，不会因为端口被占用就终止未知进程。

如果 CLI 已升级而共享 app-server 仍是旧版本，Web 会继续使用当前进程并提示需要重启。确认没有依赖该共享进程的任务后运行：

```powershell
.\scripts\windows-shared-app-server.ps1 restart
```

## 选择服务端项目目录

输入框旁的目录按钮浏览的是 **Codex Web 服务端** 的文件系统。远程使用时，即使网页打开在手机或另一台电脑上，显示的仍是运行 Codex 的那台机器上的目录。

默认可以浏览服务端用户的主目录。通过 `CODEX_WEB_BROWSE_ROOTS` 可以增加其他根目录，多个路径使用当前系统的路径分隔符。

macOS：

```sh
CODEX_WEB_BROWSE_ROOTS=/Volumes/Projects:/opt/work ./scripts/start-macos.sh
```

Windows：

```powershell
$env:CODEX_WEB_BROWSE_ROOTS = 'D:\Projects;\\server\share\work'
.\scripts\start-windows.ps1
```

网页只能列出这些根目录及其子目录。服务端会校验真实路径，阻止相对路径、越界路径和符号链接逃逸。

## 消息附件

选择项目目录后，点击输入框旁的回形针即可上传附件。支持：

- UTF-8 文本和源码
- PDF
- PNG、JPEG、WebP 和 GIF

单条消息最多 10 个文件，每个文件不超过 20 MiB，总计不超过 50 MiB。可执行文件和无法识别的二进制文件会被拒绝。

附件不是项目文件，也不会长期保存。它们暂存在运行 Codex Web 的电脑上：

```text
<项目目录>/.codex-web/attachments/<session-id>/
```

这些文件只会作为当前消息的上下文交给 Codex。任务完成、失败或中断后会自动删除；未发送的草稿附件一小时后过期。服务端还限制最多 100 个活动附件会话和 500 MiB 临时附件。

## 远程访问

Codex Web 始终只监听 `127.0.0.1`。远程模式需要由你自己配置 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 和 Cloudflare Access，不能直接把本地端口暴露到公网。

Cloudflare Tunnel 只能转发 Codex Web 的 HTTP 端口（默认 `4173`）。不要转发 Windows 原生 app-server 端口（默认 `4500`）；它使用无认证的本地 `ws`，并且只允许配置为字面量 `127.0.0.1` 或 `::1`。

启动前设置以下变量：

```text
CODEX_WEB_AUTH_MODE=remote
CODEX_WEB_CF_TEAM_DOMAIN=team.cloudflareaccess.com
CODEX_WEB_CF_AUDIENCE=<Access Application Audience>
CODEX_WEB_OWNER_EMAIL=owner@example.com
CODEX_WEB_PUBLIC_URL=https://codex.example.com
```

远程模式会校验 Cloudflare Access JWT 的签发方、Audience、有效期和用户邮箱，同时限制浏览器 Origin。配置缺失或不匹配时，服务会拒绝请求。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_WEB_PORT` | `4173` | 本地监听端口 |
| `CODEX_WEB_CODEX_EXECUTABLE` | 从 `PATH` 查找 | Codex 可执行文件的绝对路径 |
| `CODEX_WEB_BROWSE_ROOTS` | 用户主目录 | 额外允许浏览的服务端根目录 |
| `CODEX_WEB_LOCAL_ORIGINS` | `127.0.0.1:4173` 和开发端口 | 本地模式允许的浏览器 Origin，逗号分隔 |
| `CODEX_WEB_AUTH_MODE` | `local` | `local` 或 `remote` |
| `CODEX_WEB_WINDOWS_SHARED` | `auto` | Windows 共享策略：`auto`、`required` 或 `off` |
| `CODEX_WEB_APP_SERVER_URL` | `ws://127.0.0.1:4500` | Windows 共享 app-server 的字面量回环地址 |

Windows 策略含义：

- `auto`：优先共享；启动或握手失败时记录诊断并退回 Web 私有 app-server。
- `required`：必须使用共享模式；失败时 Web 保持不可用，以便部署脚本及时发现配置问题。
- `off`：不启动或连接共享进程，始终使用 Web 私有 app-server。

PowerShell 示例：

```powershell
$env:CODEX_WEB_WINDOWS_SHARED = 'required'
$env:CODEX_WEB_APP_SERVER_URL = 'ws://127.0.0.1:4500'
.\scripts\start-windows.ps1
```

修改代码或更新版本后，请重启启动脚本，再刷新浏览器。如果前端和后端协议版本不一致，页面会显示明确的重启提示。

## 本地开发

分别启动后端和 Vite：

```sh
bun run dev:server
```

```sh
bun run dev
```

开发页面位于 [http://127.0.0.1:5173](http://127.0.0.1:5173)。

常用检查：

```sh
bun run typecheck
bun test
bun run build
bun run test:e2e
```

可选的 macOS 本机冒烟测试会建立隔离的临时 Codex home 和两个 daemon 客户端，
通过两个最小模型回合验证主客户端断开后另一客户端仍能接收并继续任务，因此会产生少量模型用量。
测试结束后会归档临时任务、停止隔离 daemon 并删除临时目录：

```sh
CODEX_WEB_SMOKE=1 bun run test:smoke:daemon
```

Windows 也提供可选的原生冒烟测试。它使用隔离的临时 `CODEX_HOME`、随机空闲回环端口和两个最小模型回合，验证两个真实客户端之间的观察、续写和断线存活，会产生少量模型用量；结束时归档临时任务、验证并停止测试拥有的共享 host，然后删除临时目录：

```powershell
$env:CODEX_WEB_SMOKE_WINDOWS = '1'
bun run test:smoke:windows-shared
```

## 安全说明

- 服务只监听回环地址，不接受配置为公网监听地址。
- Windows 原生 app-server 端口同样只允许字面量回环地址，不能经 Tunnel、反向代理或防火墙规则对外暴露。
- 浏览器请求和 WebSocket 连接都会经过同源或 Access 身份校验。
- 浏览器协议只暴露 Web UI 需要的归一化数据，不转发原始 app-server 消息。
- 上传、设置、日志、历史记录和实时事件都有大小或数量上限。
- 诊断和审批日志保存在本机，写入前会进行截断和敏感字段清理。

## License

[MIT](LICENSE)

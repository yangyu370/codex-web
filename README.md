# Codex Web

在 macOS 或 Windows 上用浏览器管理本机 Codex。

Codex Web 在运行 Codex 的电脑上启动一个 Bun 服务，由它管理 `codex app-server`。浏览器只连接 Codex Web，不直接启动 Codex，也不会接触原始 app-server 协议。

> 这是一个非官方项目，与 OpenAI 没有关联。当前版本面向个人使用，Linux 和 WSL 暂不支持。

## 功能

- 新建任务或继续本机已有的 Codex 任务
- 选择模型、工作目录并发送消息
- 浏览运行 Codex Web 那台电脑上的项目目录
- 查看回答、命令、文件变更、计划和运行状态
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

启动完成后访问 [http://127.0.0.1:4173](http://127.0.0.1:4173)。启动脚本会先构建前端，再启动服务；它不会安装或升级 Bun、Codex，也不会修改现有的 `CODEX_HOME`。

如果 Codex 不在 `PATH` 中，可以手动指定：

```sh
CODEX_WEB_CODEX_EXECUTABLE=/absolute/path/to/codex ./scripts/start-macos.sh
```

```powershell
$env:CODEX_WEB_CODEX_EXECUTABLE = 'C:\absolute\path\to\codex.exe'
.\scripts\start-windows.ps1
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

可选的本机 Codex 冒烟测试不会启动模型回合，并会在测试后归档临时任务：

```sh
CODEX_WEB_SMOKE=1 bun run test:smoke
```

## 安全说明

- 服务只监听回环地址，不接受配置为公网监听地址。
- 浏览器请求和 WebSocket 连接都会经过同源或 Access 身份校验。
- 浏览器协议只暴露 Web UI 需要的归一化数据，不转发原始 app-server 消息。
- 上传、设置、日志、历史记录和实时事件都有大小或数量上限。
- 诊断和审批日志保存在本机，写入前会进行截断和敏感字段清理。

## License

[MIT](LICENSE)

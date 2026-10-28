# dsh-libtv

**LibTV 的 DeepSeek Harness 插件**：一次安装，同时带来 LibTV 的 MCP 工具（画布、图片/视频/音频生成、剧本、剪辑、导出）和三个生产用技能。

不需要预装 Node，不需要敲命令。**首次使用时会自动打开浏览器，用微信扫码授权一次，之后长期有效。**
<a id="install"></a>
## 安装

在 DSH 里任选一种：

```bash
# 1) 插件市场（dshmarket）里搜 dsh-libtv，点安装
# 2) CLI
dsh plugin add dsh-libtv
```

安装后无需重启：工具和技能会在当前会话内直接出现。
<a id="first-run"></a>
## 首次使用：扫一次码

第一次让模型做 LibTV 相关的事时，它会调用内置的 `libtv_auth` 工具，你的默认浏览器会自动打开 LibTV 授权页：

1. 浏览器里用**微信扫码**登录 / 确认授权；
2. 看到"授权成功"，回到 DSH 继续说你要做的事即可。

凭据保存在 `~/.libtv/credentials.json`（权限 0600），access token 约 1 小时到期，由 refresh token 自动续期，不需要再扫。换机器、删了凭据、或长期未用导致 refresh 失效时，重复上面这一次扫码即可。

> 也可以自己开口触发：告诉模型「用 libtv_auth 授权 LibTV」。

### 为什么必须扫码

LibTV Remote MCP 用的是 **OAuth 2.1 授权码 + PKCE**（`https://mcp.liblib.tv/mcp`），令牌只能由你本人的 LibTV 账户签发，插件无权代你登录。扫码是这套标准流程的自然界面，也是插件唯一无法替你完成的一步——正因如此，它不需要你填任何 API Key 或密码。
<a id="what-you-get"></a>
## 装完有什么

### 工具（`mcp__libtv__*`）

1 个本地工具 + 86 个 LibTV 远端工具：

| 类别 | 代表工具 |
| --- | --- |
| 授权 | `libtv_auth`（本地：status / start / logout） |
| 账户与画布 | `doctor`、`account_user`、`list_projects`、`target_project`、`read_project`、`create_node`、`update_node`、`manage_group` |
| 生成 | `search_models`、`get_model`、`generation_submit`、`generate_video`、`task_status` |
| 上传与资产 | `upload_ticket`、`upload_complete`、`upload_media`、`search_assets`、`apply_asset_to_canvas` |
| 剧本与分镜 | `create_screenplay`、`read_screenplay`、`write_screenplay`、`create_script_v2`、`edit_script_v2` |
| 音频 | `edit_audio`、`synthesize_speech`、`design_voice`、`register_voice` |
| 剪辑与导出 | `apply_timeline_edit`、`read_timeline`、`export_readiness`、`export_video`、`export_status`、`prepare_project_delivery` |
| Agent | `run_agent`、`get_agent_status`、`steer_agent_run`、`resolve_agent_action` |

### 技能

- `libtv-to-treatment` — 把画布成果整理成可翻页的导演提案
- `libtv-blender-live-action` — 剧本 → Blender 白模预演 → Seedance 实拍视频
- `music-driven-product-ad` — 20 秒音乐驱动产品广告
<a id="env"></a>
## 可选配置

一般不需要动。都是环境变量，改宿主环境即可：

| 变量 | 作用 |
| --- | --- |
| `LIBTV_HOME` | 凭据目录，默认 `~/.libtv` |
| `LIBTV_OAUTH_PORT` | 本地回调端口，默认 `8765`；被占用时换一个 |
| `LIBTV_OPEN_BROWSER=0` | 不自动开浏览器，只把授权链接打出来（远程/无头环境） |
| `LIBTV_TOOL_FILTER` | 只暴露指定工具，逗号分隔，如 `doctor,list_projects,generate_video` |
| `LIBTV_MCP_URL` / `LIBTV_ISSUER` | 指向自建网关时才需要 |

> 86 个工具的 schema 会常驻上下文。如果你只用其中几类，建议用 `LIBTV_TOOL_FILTER` 或写一行到 `~/.libtv/tools.allow`（每行一个工具名，`#` 开头为注释）来瘦身。
<a id="how"></a>
## 它怎么工作

```
DSH 宿主
  └─ stdio: process.execPath lib/main.mjs           ← 不依赖系统 Node
       └─ lib/serve.mjs   协议桥 + OAuth 网关 + 工具过滤
            └─ https://mcp.liblib.tv/mcp           ← Bearer token，401 自动刷新重放
```

- **未授权也能正常加载**：宿主握手由本地应答，工具面板里只有 `libtv_auth`，模型一调它就开浏览器。授权成功后自动建立远端会话并刷新工具列表，无需重启。
- **令牌不出本机**：只写 `~/.libtv/credentials.json`；不读任何环境变量里的 token（宿主会清洗 `*_TOKEN` 之类的子进程环境变量）。
- **长任务不超时**：`toolCallTimeoutMs` 设为 20 分钟，视频生成/导出不会被误判。
<a id="troubleshoot"></a>
## 排障

| 现象 | 处理 |
| --- | --- |
| 浏览器没弹出来 | 看 DSH 日志里的授权链接，手动打开；或 `LIBTV_OPEN_BROWSER=0` 后由模型转述链接 |
| 回调端口被占用 | 设 `LIBTV_OAUTH_PORT=8766` 后重新授权 |
| 工具报"尚未授权" | 调 `libtv_auth` 的 `status`，必要时 `start` 重新扫码 |
| 想换账号 | `libtv_auth` 的 `logout`，再 `start` |
| 工具太多占上下文 | 用 `LIBTV_TOOL_FILTER` 或 `~/.libtv/tools.allow` |

无头环境可以直接跑 CLI（等价于 `libtv_auth`，只是不经过模型）：

```bash
npx -p dsh-libtv libtv-auth login    # 打印授权链接并等待回调
npx -p dsh-libtv libtv-auth status
npx -p dsh-libtv libtv-auth logout
```
<a id="dev"></a>
## 开发

```bash
git clone <repo> && cd dsh-libtv
node lib/cli.mjs status          # 用本机凭据自检
node ../test-serve.mjs           # 模拟宿主跑一遍握手与工具列表
```

改完本地联调：在 DSH 里把插件目录直接装上去

```
plugin_manager install_bundle target=<绝对路径>/dsh-libtv
```

## License

MIT

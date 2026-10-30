# Work Board - Quick Start / 快速入门

Work Board 是一个本地优先的 Copilot 工作台：选择文件夹、描述任务、执行并查看结果，之后可继续追问。

Work Board is a local-first Copilot workspace: choose a folder, describe a task, run it, review the results, and follow up.

## 1. 准备环境 / Prerequisites

| 中文 | English |
| --- | --- |
| 安装 Git 和 Node.js，推荐 **Node.js 24 LTS**（包含 npm）。 | Install Git and Node.js; **Node.js 24 LTS** with npm is recommended. |
| 安装 [GitHub Copilot CLI](https://github.com/github/copilot-cli)，确保终端可以运行 `copilot`，并使用有 Copilot 访问权限的账号完成登录。 | Install [GitHub Copilot CLI](https://github.com/github/copilot-cli), make sure `copilot` is on your PATH, and sign in with an account that has Copilot access. |

```sh
copilot login
```

本地启动网站不需要注册 Azure / Entra 应用；Copilot 登录和 MCP 服务授权是独立的。

No Azure / Entra app registration is required for the local website. Copilot sign-in and MCP service authorization are separate.

## 2. Quick Start / 快速启动

### Windows PowerShell

在终端依次执行以下命令。已有项目时，直接进入项目目录，跳过 `git clone`。

Run these commands in order. If you already have a checkout, enter that folder and skip `git clone`.

```powershell
git clone https://github.com/chunxli/WorkBoard.git
Set-Location .\WorkBoard
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm ci
npm run background:start
Start-Process "http://127.0.0.1:3100"
```

### macOS / Linux

```sh
git clone https://github.com/chunxli/WorkBoard.git
cd WorkBoard
test -f .env || cp .env.example .env
npm ci
npm run background:start
```

启动成功后打开 **[http://127.0.0.1:3100](http://127.0.0.1:3100)**。

After startup succeeds, open **[http://127.0.0.1:3100](http://127.0.0.1:3100)**.

| 中文 | English |
| --- | --- |
| 首次启动会自动生成数据库客户端、应用数据库迁移并构建应用，请等待成功提示。 | First startup generates the database client, applies database migrations, and builds the app. Wait for the success message. |
| 上述命令不会覆盖已有的 `.env`。保持其中两个网站 Entra 凭据为空，即为仅本机可访问的免登录模式。 | These commands do not overwrite an existing `.env`. Leave both website Entra credentials empty for login-free, loopback-only local access. |
| 默认启用当前用户登录自启动。不需要时，在启动前将 `.env` 中的 `WORKBOARD_AUTOSTART` 改为 `"false"`。Linux 自启动需要可用的 systemd 用户服务。 | Current-user login autostart is enabled by default. To opt out, set `WORKBOARD_AUTOSTART` to `"false"` in `.env` before starting. Linux autostart requires working systemd user services. |

## 3. 首次使用建议配置 / Recommended Initial Setup

建议首次启动后先配置模板、常用目录和执行默认值，再创建第一个任务。

Before creating your first Work, set up reusable templates, a preferred working directory, and execution defaults.

### Prompt 模板 / Prompt Templates

| 中文 | English |
| --- | --- |
| 打开 [Settings → Prompt templates](http://127.0.0.1:3100/settings#prompt-templates)，填写名称和 Prompt，点击 **Add template**；也可通过 **Import file** 导入 Markdown 或文本文件，再保存。 | Open [Settings → Prompt templates](http://127.0.0.1:3100/settings#prompt-templates), enter a name and prompt, and choose **Add template**. Alternatively, use **Import file** to load a Markdown or text file, then save it. |
| 建议先创建 1–2 个常用模板，例如“问题分析”或“报告生成”，写明目标、输入、输出格式和限制。在 New work 的 **Quick templates** 中选择模板，用 **Append** 追加，或用 **Replace** 替换现有 Prompt。 | Start with one or two templates, such as issue analysis or report generation. Specify the goal, inputs, output format, and constraints. Select a template under **Quick templates** in New work; use **Append** to add it or **Replace** to replace the current prompt. |

### 常用 / 默认目录 / Preferred Working Directory

| 中文 | English |
| --- | --- |
| 打开 [Settings → Work directories](http://127.0.0.1:3100/settings)，填写目录标签和绝对路径，例如 `Projects`、`C:\work`，点击 **Add** 保存常用根目录。路径应指向运行 Work Board 的电脑。 | Open [Settings → Work directories](http://127.0.0.1:3100/settings), enter a label and absolute path, such as `Projects` and `C:\work`, and choose **Add** to save a root shortcut. The path must refer to the machine hosting Work Board. |
| 回到 **Work → New work**，在左侧选择该根目录。应用会为同一浏览器、同一用户记住上次选择的已保存根目录，刷新或服务重启后恢复，作为下次浏览的默认位置；每个 Work 的实际 **Work Directory** 仍需单独选择。 | Return to **Work → New work** and select that root on the left. For the same browser and user, the app remembers the last selected saved root and restores it after refresh or a server restart as the starting location. Select the actual **Work Directory** separately for each Work. |

### 执行默认值 / Execution Defaults

| 中文 | English |
| --- | --- |
| 打开 [Settings → Execution defaults](http://127.0.0.1:3100/settings#execution-defaults)。建议从 **Runtime: Copilot CLI**、**Model: Auto**、**Permissions: Standard tools** 开始，**Context** 和 **Think effort** 保持 **Default**，熟悉后再按需调整。 | Open [Settings → Execution defaults](http://127.0.0.1:3100/settings#execution-defaults). Start with **Runtime: Copilot CLI**, **Model: Auto**, and **Permissions: Standard tools**, leaving **Context** and **Think effort** at **Default**. Adjust them as needed once familiar with the workflow. |
| 按任务时长设置 Timeout；Automation 有独立的超时设置。点击 **Save defaults** 保存。默认值仅用于之后新建的 Work 和 Automation，不会覆盖现有项目；**Full access** 仅在明确需要且信任工作目录时选择。 | Set a timeout appropriate to your task; Automation has a separate timeout. Choose **Save defaults**. Defaults apply to newly created Works and Automations without overwriting existing items. Select **Full access** only when explicitly needed and the working directory is trusted. |

## 4. 第一个任务 / Your First Work

| 步骤 / Step | 中文 | English |
| --- | --- | --- |
| 1. Work Directory | 在 **Work** 页的 **New work** 区域选择或输入工作文件夹路径。名称由文件夹自动生成，不会重命名磁盘文件夹。 | On the **Work** page, select or enter a working folder in **New work**. The Work name comes from the folder; the folder is not renamed. |
| 2. Prompt | 写清目标、输入文件和期望输出；可粘贴图片、拖放文件或使用 **Add files**。 | Describe the goal, input files, and expected output. Paste images, drop files, or use **Add files** if needed. |
| 3. Runtime | 初次使用保留默认 **Copilot CLI** 即可；有需要再选择模型或调整执行设置。 | Start with the default **Copilot CLI** runtime. Choose a model or adjust execution settings when needed. |
| 4. Create & Run | 点击 **Create & Run** 创建并执行；**Create only** 只保存，稍后可用 **Execute** 执行。 | Choose **Create & Run** to save and execute, or **Create only** to save and run later with **Execute**. |
| 5. Review | 在 **Conversation** 查看回复和工具执行情况，在文件区查看产出；**Raw output** 和 **Run history** 提供详细记录。 | Review replies and tool activity in **Conversation**, and inspect outputs in the file pane. Use **Raw output** and **Run history** for details. |
| 6. Follow Up | 任务结束后，在底部输入新要求，按 **Enter** 或点击 **Send Follow Up** 发送，**Shift+Enter** 换行，沿用同一会话继续。暂时不用的 Work 可归档。 | Once the Run finishes, enter another request and press **Enter** or choose **Send Follow Up** to continue the same session. Use **Shift+Enter** for a new line. Archive a Work when it is no longer needed. |

示例 Prompt / Example Prompt:

```text
Read the Markdown files in this folder and create SUMMARY.md.
Include a short overview, key findings, and open questions.
Do not modify the source files.
```

**注意：任务在真实文件夹中执行，可能修改文件。重要内容请先备份或使用 Git。**

**Runs operate on real folders and may modify files. Back up important content or use Git first.**

## 5. 常用操作 / Everyday Use

| 入口 / Area | 中文 | English |
| --- | --- | --- |
| Work | 管理工作文件夹、Prompt、执行结果和后续追问。 | Manage folders, prompts, results, and follow-up conversations. |
| Automations | 为重复工作配置定时或手动任务。 | Configure scheduled or manually triggered recurring tasks. |
| Runs | 查看执行状态与历史，打开单次执行详情。 | Check execution status and history, and open individual Run details. |
| Settings | 管理 Prompt 模板、常用目录、新任务的执行默认值和系统通知。 | Manage prompt templates, saved directories, execution defaults for new tasks, and system notifications. |
| Docs | 查看完整的中英文功能说明。 | Read the full Chinese / English feature guide. |

## 6. 服务管理 / Server Commands

在 Work Board 项目目录执行；重启或停止前，先等待正在执行的任务完成。

Run these from the Work Board project folder. Wait for active Runs to finish before restarting or stopping.

| 命令 / Command | 中文 | English |
| --- | --- | --- |
| `npm run background:start` | 后台启动；已健康运行时复用现有服务。 | Start in the background, or reuse the healthy managed instance. |
| `npm run background:status` | 检查运行状态和登录自启动状态。 | Check server health and login autostart status. |
| `npm run background:logs` | 查看服务诊断日志。 | View server diagnostic logs. |
| `npm run background:restart` | 重新构建并重启，应用代码或配置更新。 | Rebuild and restart after code or configuration changes. |
| `npm run background:stop` | 停止服务，并移除本项目的登录自启动项。 | Stop the server and remove this checkout's login autostart entry. |

## 7. 使用提示 / Good to Know

| 中文 | English |
| --- | --- |
| 后台启动成功后，可以关闭终端和浏览器标签页；服务仍需运行，电脑不能休眠或关机。 | After background startup succeeds, you can close the terminal and browser tabs. The server must remain running and the computer awake. |
| 完成通知由服务发送到运行 Work Board 的电脑；需在 App 和操作系统中允许通知，勿扰模式可能隐藏提示。 | Completion notifications appear on the machine hosting Work Board. Enable them in the app and OS; Do Not Disturb may hide them. |
| 默认 `RUN_CONCURRENCY="5"`，表示单个服务最多同时执行 5 个排队 Run，其余等待。修改后重启生效。 | The default `RUN_CONCURRENCY="5"` allows up to five queued Runs at once per server process. Restart after changing it. |
| 本机空闲 Work 的根目录确认已删除时，会自动移入 **Archived**，保留历史且不重建目录；列表加载时及后台每 30 秒检查。运行中、Terminal 占用、访问错误或仅子文件缺失时不会误归档。目录恢复后可手动 Restore。 | An idle local Work with a confirmed deleted root moves to **Archived**, retaining history without recreating the folder. Checks run on list loading and every 30 seconds. Active Runs, Terminal ownership, access errors, or missing child files do not trigger archiving. Restore manually after recovering the folder. |
| CLI 运行中可以起草 Follow Up，但只能结束后发送。SDK 支持运行中 Steer 和审批；等待人工答复时需要打开页面处理。 | With CLI, draft a Follow Up during execution and send it after completion. SDK supports live Steering and approvals; reopen the page to answer pending interactions. |
| MCP 提示认证时，在 Terminal 运行 `copilot` 并通过 `/mcp` 按提示授权。Terminal 认证不保证能被 SDK 会话复用；持续失败时查看具体工具错误。 | If MCP requests authentication, run `copilot` in Terminal and follow `/mcp` prompts. Terminal authentication is not guaranteed to carry over to SDK sessions; inspect the specific tool error if it still fails. |

更多说明 / More details: [完整 README / Full README](README.md) · [应用内文档 / In-app Docs](http://127.0.0.1:3100/docs)

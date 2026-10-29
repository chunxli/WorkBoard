export interface BilingualText {
  zh: string;
  en: string;
}

export interface DocsFeature extends BilingualText {
  title: string;
  href?: string;
  label?: string;
  code?: string;
}

export interface DocsSection {
  id: string;
  title: string;
  subtitle: BilingualText;
  features: DocsFeature[];
}

export interface ReleaseNote extends BilingualText {
  title: string;
}

export interface ReleaseEntry {
  date: string;
  version: string;
  status: "latest" | "released";
  title: BilingualText;
  notes: ReleaseNote[];
}

export const docsNavigation = [
  { id: "release-notes", label: "Release Notes", zh: "版本说明" },
  { id: "quick-start", label: "Quick Start", zh: "快速入门与初始配置" },
  { id: "work-lifecycle", label: "Work Lifecycle", zh: "Work 生命周期" },
  { id: "prompts-files", label: "Prompts & Files", zh: "Prompt 与文件" },
  { id: "runs-sessions", label: "Runs & Sessions", zh: "运行与会话" },
  { id: "automations", label: "Automations", zh: "自动化" },
  { id: "experiments-skills", label: "Experiments & Skills", zh: "实验与技能" },
  { id: "settings-auth", label: "Settings & Auth", zh: "设置与认证" },
  { id: "operations", label: "Operations", zh: "运行维护" },
] as const;

export const releaseNotes: ReleaseEntry[] = [
  {
    date: "2026-10-29",
    version: "Latest changes",
    status: "latest",
    title: {
      zh: "近期源码更新：快速入门、初始配置与会话体验",
      en: "Recent source updates: Quick Start, initial setup and conversation",
    },
    notes: [
      {
        title: "Quick Start & Initial Setup",
        zh: "新增中英对照快速入门：Windows/macOS/Linux 后台启动命令，以及 Prompt 模板、常用根目录、Execution defaults 和首个任务的推荐流程。",
        en: "Adds a bilingual Quick Start with Windows/macOS/Linux background startup commands, recommended Prompt templates, saved root directories, execution defaults, and the first-Work workflow.",
      },
      {
        title: "Refresh-Stable Input Order",
        zh: "刷新分页未包含当前 Follow Up 的原始输入时，按保存的提交时间在后续回复之前显示，不追加到时间线底部；加载 Earlier 后以原始消息替换并去重。",
        en: "When a refreshed history page omits the current Follow Up input, its saved prompt appears before later replies by submission time instead of at the bottom. Earlier history replaces the placeholder without duplication.",
      },
      {
        title: "Run Concurrency",
        zh: "默认 RUN_CONCURRENCY 调整为 5；单个服务进程最多同时执行五个队列 Run。环境配置修改后需重启，不改变同 key 串行或独占等待规则。",
        en: "RUN_CONCURRENCY now defaults to 5 queued Runs per server process. Restart after changing the environment setting; same-key serialization and exclusive waiting rules remain unchanged.",
      },
      {
        title: "Selected Directory References",
        zh: "New work 名称栏显示单击选中文件夹内部的直接内容，不显示兄弟目录。支持光标插入、选区替换和独立刷新；只引用名称，不递归或上传。",
        en: "The New work strip shows the selected Work Directory's immediate contents, not its siblings. Insert names at the caret or replace selected text, with independent refresh and no recursion or upload.",
      },
      {
        title: "Message Attachments",
        zh: "Follow Up / Steer now 支持粘贴、拖放、选文件及仅附件发送：单文件 25 MiB、每条最多 10 个、合计 100 MiB。点击发送才保存到所属 Work，失败保留草稿和上传引用。",
        en: "Follow Up / Steer now support paste, drop, selection and attachment-only messages: 25 MiB per file, 10 files and 100 MiB per message. Send saves files in the owning Work; failures retain drafts and upload receipts.",
      },
      {
        title: "Conversation Workspace",
        zh: "Work 详情使用可用宽度，独立侧边选项卡、固定工具栏和底部 Follow Up 输入框为对话留出空间；文件区支持展开目录和安全新标签页访问。",
        en: "Available-width Work details use side tabs, a pinned toolbar and a bottom-docked Follow Up composer. Expand folders in the file pane and open files safely in a new tab.",
      },
      {
        title: "Compact Conversation Activity",
        zh: "正文与间距更紧凑，工具调用按相关 ID 合并并在完成后折叠；空正文和重复展示不再占位，底层历史与审计仍保留。",
        en: "Denser prose and spacing emphasize answers. Related tool calls are grouped and fold on completion; empty prose and duplicate panels are omitted without deleting history or audit records.",
      },
      {
        title: "Default-on Login Autostart",
        zh: "后台 start/restart 就绪后按配置登记当前用户登录自启，显式 stop 移除；默认启用意图不等于已登记。登录仅启动已构建版本，不构建、迁移或崩溃自动重启。",
        en: "Ready background start/restart reconciles current-user login startup; explicit stop removes it. Default-enabled intent is not registration. Login starts a prepared Release without building, migrating or crash restart.",
      },
      {
        title: "Windows PowerShell Compatibility",
        zh: "修复 PowerShell 5.1 将缺失自启值输出为空导致的检查误报；明确区分未登记、有效值与读取失败。只读 status 不会登记自启，服务启动与登记结果分别报告。",
        en: "Fixes Windows PowerShell 5.1 emitting no JSON for an absent startup value. Absence, valid values and read failures remain distinct; read-only status never registers startup, and process/registration results stay separate.",
      },
      {
        title: "Optional Skill Comparison UI",
        zh: "Skill comparison 创建区域默认隐藏，WORKBOARD_SHOW_SKILL_COMPARISON=true 才显示；已有比较结果和后台 API 不受影响。",
        en: "Skill comparison creation is hidden by default; WORKBOARD_SHOW_SKILL_COMPARISON=true reveals it without disabling existing results or APIs.",
      },
      {
        title: "Source Upgrade & Data Retention",
        zh: "本条日期表示当前源码汇总，不是发布或部署确认。附件更新需先迁移数据库再构建/重启；备份应包含 Work 附件、数据库及 Copilot session 历史。",
        en: "This date identifies the source summary, not a release or deployment. Apply the attachment migration before building/restarting; back up Work attachments, SQLite and Copilot session history together.",
      },
      {
        title: "First Run in Terminal",
        zh: "创建 Work 时可直接打开 Windows Terminal，用已保存 Prompt 启动全新的交互式 Copilot Session。",
        en: "Create a Work and immediately open a new interactive Copilot session from its saved Prompt.",
      },
      {
        title: "Background System Notifications",
        zh: "Work、Automation 和聚合 Experiment 在成功、失败或超时时发送主机系统通知，浏览器关闭后仍有效。Windows 使用 Work Board 名称与绿色图标，精简显示状态、名称和指标；点击打开所属 Work，独立 Automation 打开其 Run。",
        en: "Host notifications cover successful, failed and timed-out Work/Automation Runs and aggregate Experiments even with browsers closed. Windows uses the Work Board name/green icon and compact status, name and metrics; selecting opens its Work, or the Run for standalone Automations.",
      },
      {
        title: "Stable Process Info",
        zh: "实时 CPU 与内存轮询不再覆盖冻结的 model、fallback、权限与 timeout 设置，也不会因请求乱序倒退。",
        en: "Live CPU and memory polling no longer overwrites frozen model, fallback, permission, or timeout settings, and responses cannot regress out of order.",
      },
      {
        title: "Terminal Lifecycle Hardening",
        zh: "Terminal 历史每分钟同步，启动时补扫；运行中不结束 Run，停止后依据退出码或完整历史收口。IN TERMINAL、浅绿色 SYNCING / TERMINAL 区分活动、收口和缺少完成证据，不因关窗口就判成功。",
        en: "Minute history sync catches up at startup, preserves active Runs and settles stopped ones from exit codes or complete history. IN TERMINAL and light-green SYNCING / TERMINAL distinguish activity, settlement and missing evidence; closing a window is not success.",
      },
      {
        title: "In-App Documentation",
        zh: "新增当前文档页，集中说明功能、入口、运行边界和版本变化。",
        en: "A new in-app documentation page describes features, entry points, operational boundaries, and release changes.",
      },
      {
        title: "New Folder Creation",
        zh: "New Work 的内嵌目录浏览器与 Browse 弹窗可在当前目录创建新文件夹，并自动将其选为 Work Directory。",
        en: "Create a child folder from either New Work directory browser and automatically select it as the Work Directory.",
      },
    ],
  },
  {
    date: "2026-09-03",
    version: "e461da3",
    status: "released",
    title: {
      zh: "可靠会话与运行洞察",
      en: "Resilient sessions and Run insights",
    },
    notes: [
      {
        title: "In-App Follow Up",
        zh: "在 Work 详情页继续向同一 Session 发送 Prompt，并保留父子 Run 导航。",
        en: "Continue an existing Work session from its detail page with parent and child Run navigation.",
      },
      {
        title: "Model & Token Insights",
        zh: "Work 卡片显示实际使用的模型与 input/output token，并提供 cache 与 reasoning 明细。",
        en: "Work cards show actual models and input/output tokens with cache and reasoning details.",
      },
      {
        title: "Completion Integrity",
        zh: "不再只凭 exit code 0 判定成功；未完成工具、子代理或缺少根级最终答复会触发自动续跑。",
        en: "Exit code 0 is no longer enough: unfinished tools, sub-agents, or a missing root response trigger automatic continuation.",
      },
      {
        title: "Markdown Results",
        zh: "Result 支持安全的 GitHub Flavored Markdown 渲染，同时保留原始 artifacts。",
        en: "Results render safe GitHub Flavored Markdown while preserving the original artifacts.",
      },
      {
        title: "Prompt Imports & Local Auth",
        zh: "可读取已有 Prompt 文件，并支持 loopback-only 的免登录本地模式与后台 restart 命令。",
        en: "Existing Prompt files can be imported, with loopback-only login-free local mode and background restart commands.",
      },
      {
        title: "Faster Sync",
        zh: "非 Git 大目录使用增量快照，实时日志只读取有界尾部，显著减少 Sync 与页面卡顿。",
        en: "Incremental non-Git snapshots and bounded live log tails reduce Sync time and UI stalls.",
      },
    ],
  },
  {
    date: "2026-09-01",
    version: "4315291",
    status: "released",
    title: {
      zh: "Work Board 基础版本",
      en: "Work Board foundation",
    },
    notes: [
      {
        title: "CodeBoard to Work Board",
        zh: "将任务执行体验升级为以本地目录和可移植 Prompt 为中心的 Work 工作区。",
        en: "Evolved task execution into a Work workspace centered on local directories and portable prompts.",
      },
      {
        title: "Work Cards & Dual Engines",
        zh: "引入 Work 卡片、可排序布局，以及 Copilot CLI 与 SDK 双引擎。",
        en: "Introduced sortable Work cards and both Copilot CLI and SDK engines.",
      },
      {
        title: "Portable Artifacts",
        zh: "每个 Run 产出 result、transcript、diff、snapshot 和 stdout/stderr 文件。",
        en: "Every Run produces result, transcript, diff, snapshot, and stdout/stderr artifacts.",
      },
      {
        title: "Terminal Resume & Skill Comparisons",
        zh: "支持 Windows Terminal 恢复 Session，以及基于冻结副本的 Skill variants 对比。",
        en: "Added Windows Terminal session resume and Skill variant comparisons from frozen copies.",
      },
      {
        title: "Automation Compatibility",
        zh: "保留手动、cron、GitHub webhook 和 Bearer API 自动化入口。",
        en: "Preserved manual, cron, GitHub webhook, and bearer API automation triggers.",
      },
    ],
  },
];

export const docsSections: DocsSection[] = [
  {
    id: "quick-start",
    title: "Quick Start",
    subtitle: {
      zh: "首次使用建议：启动网站后，先配置模板、常用目录和执行默认值，再创建第一个 Work。",
      en: "Start the website, configure reusable templates, a preferred working directory and execution defaults, then create your first Work.",
    },
    features: [
      {
        title: "Prerequisites",
        zh: "安装 Git、Node.js（推荐 24 LTS，包含 npm）和 GitHub Copilot CLI，确保终端可运行 copilot，并用有 Copilot 权限的账号执行 copilot login。本地网站的两个 Entra 凭据保持为空即可免登录、仅 loopback 访问；Copilot 登录和 MCP 服务授权是独立的。",
        en: "Install Git, Node.js (24 LTS with npm recommended), and GitHub Copilot CLI on PATH. Run copilot login with an account that has Copilot access. Leave both website Entra credentials empty for login-free loopback access; Copilot sign-in and MCP authorization are separate.",
      },
      {
        title: "Windows PowerShell",
        zh: "在终端依次执行；已有 checkout 时跳过 clone 并进入项目目录。复制不会覆盖已有 .env。首次 background:start 自动生成 Prisma Client、应用数据库迁移并构建应用，等待成功提示后访问本机 3100 端口。",
        en: "Run these commands in order; skip clone and enter the project folder if a checkout already exists. The copy preserves an existing .env. First background startup generates Prisma Client, applies migrations and builds the app. Wait for success, then open the local site on port 3100.",
        code: [
          "git clone https://github.com/chunxli/WorkBoard.git",
          "Set-Location .\\WorkBoard",
          "if (-not (Test-Path .env)) { Copy-Item .env.example .env }",
          "npm ci",
          "npm run background:start",
          'Start-Process "http://127.0.0.1:3100"',
        ].join("\n"),
      },
      {
        title: "macOS / Linux",
        zh: "首次启动完成后打开 http://127.0.0.1:3100。默认登记当前用户登录自启动；不需要时在启动前将 .env 中 WORKBOARD_AUTOSTART 改为 false。Linux 自启动要求可用的 systemd 用户服务，否则先关闭该选项。",
        en: "After startup succeeds, open http://127.0.0.1:3100. Current-user login autostart is enabled by default; set WORKBOARD_AUTOSTART=false in .env before starting to opt out. Linux autostart requires working systemd user services; disable it first if unavailable.",
        code: [
          "git clone https://github.com/chunxli/WorkBoard.git",
          "cd WorkBoard",
          "test -f .env || cp .env.example .env",
          "npm ci",
          "npm run background:start",
        ].join("\n"),
      },
      {
        title: "Prompt Templates",
        zh: "进入 Settings → Prompt templates，填写名称与 Prompt 后点击 Add template；或用 Import file 导入 Markdown/文本后保存。建议先准备问题分析、报告生成等 1–2 个模板，明确目标、输入、输出与限制。在 New work 的 Quick templates 选择模板，用 Append 追加或 Replace 替换；模板不会自动应用到所有任务。",
        en: "In Settings → Prompt templates, enter a name and prompt, then choose Add template; alternatively, Import file loads Markdown/text for saving. Start with one or two templates such as issue analysis or report generation, specifying goals, inputs, outputs and constraints. Use Quick templates in New work with Append or Replace; templates are not automatically applied to every task.",
        href: "/settings#prompt-templates",
        label: "Configure Prompt templates",
      },
      {
        title: "Preferred Working Directory",
        zh: "在 Settings → Work directories 输入标签和绝对路径（如 Projects、C:\\work），点击 Add 保存根目录快捷方式。路径属于运行 Work Board 的电脑。回到 Work → New work，在左侧选择已保存根目录；同一浏览器、同一用户会记住上次选择，刷新或服务重启后恢复。每个 Work 的实际 Work Directory 仍需单独选择。",
        en: "In Settings → Work directories, enter a label and absolute path, such as Projects and C:\\work, then choose Add to save a root shortcut on the machine hosting Work Board. Select that saved root on the left of Work → New work. The same browser/user remembers it across refresh and server restarts; select each Work's actual Work Directory separately.",
        href: "/settings",
        label: "Configure Work directories",
      },
      {
        title: "Recommended Execution Defaults",
        zh: "在 Settings → Execution defaults，建议从 Runtime: Copilot CLI、Model: Auto、Permissions: Standard tools 开始，Context 与 Think effort 保持 Default。按任务时长设置 Timeout；Automation 有独立超时。点击 Save defaults，仅影响之后新建的 Work/Automation，不覆盖现有配置。Full access 仅在明确需要且信任目录时选择。",
        en: "In Settings → Execution defaults, start with Runtime: Copilot CLI, Model: Auto and Permissions: Standard tools; leave Context and Think effort at Default. Set task-appropriate timeouts; Automation has its own timeout. Save defaults applies to newly created Works/Automations, not existing items. Select Full access only when explicitly needed and the folder is trusted.",
        href: "/settings#execution-defaults",
        label: "Configure Execution defaults",
      },
      {
        title: "Your First Work",
        zh: "在 Work → New work 选择目录，填写目标和期望输出，可添加图片或文件，然后 Create & Run。Create only 只保存，稍后可用 Execute。Conversation 查看回复和工具，文件区查看产出；Raw output 与 Run history 提供细节。CLI 结束后用 Send Follow Up 沿用会话继续，运行中只能起草。任务会操作真实文件，重要内容先备份或使用 Git。",
        en: "In Work → New work, choose a folder, describe the goal and expected output, optionally add images/files, then Create & Run. Create only saves for a later Execute. Review Conversation, the file pane, Raw output and Run history. After a CLI Run finishes, Send Follow Up continues the same session; while running, only draft. Runs operate on real files: back up important content or use Git first.",
        href: "/work",
        label: "Create your first Work",
      },
    ],
  },
  {
    id: "work-lifecycle",
    title: "Work Lifecycle",
    subtitle: {
      zh: "从本地目录创建、执行、追问、审阅到归档的完整流程。",
      en: "The full lifecycle from local directory creation through execution, follow-up, review, and archive.",
    },
    features: [
      {
        title: "New Work",
        zh: "输入或浏览绝对路径，使用当前目录、复制已注册 Resource，或创建递增编号的目录副本。缺失目录会自动创建。",
        en: "Enter or browse an absolute path, use it directly, copy a registered Resource, or create the next numbered folder copy. Missing directories are created automatically.",
        href: "/work",
        label: "Open Work Board",
      },
      {
        title: "Prompt File Names",
        zh: "New work 的 Prompt 下方提供单行横向滚动栏，显示已选 Work Directory 内的全部直接子项（含点号开头名称），不递归。单击左侧文件夹即可显示它内部的内容，无需双击进入；Directory 输入、Browse、Use current、新建及复制后的路径均同步，单纯浏览其他父目录不会改变来源。点击或键盘激活名称后替换选中文字，或在上次光标处插入，按需补空格并恢复焦点。仅引用名称，不改变路径、不读取或上传内容。名称栏有独立刷新/重试；未选、缺失或无权读取时明确提示，不用上级目录兜底，保留原有模板、Read Prompt 与创建流程。",
        en: "A single-row horizontal strip below the New work Prompt lists all immediate entries inside the selected Work Directory, including dot-prefixed names, without recursion. Single-click a left-side folder to show its contents without double-clicking into it. Directory input, Browse, Use current, new folders and copied destinations all update that source; merely browsing another parent does not. Activate a name to replace selected text or insert at the remembered caret, adding spaces only as needed and restoring focus. Names do not change paths or read/upload contents. The strip has independent refresh/retry; unselected, missing or unreadable paths show explicit feedback, never parent-folder fallback. Templates, Read Prompt and Create actions remain unchanged.",
      },
      {
        title: "Create Actions",
        zh: "Create only 只保存；Create & Run 在应用内启动 Run；Create & Open Terminal 用保存后的 Prompt 启动第一个交互式 Terminal Session。",
        en: "Create only saves; Create & Run starts an in-app Run; Create & Open Terminal starts the first interactive Terminal session from the saved Prompt.",
        href: "/work",
        label: "Create Work",
      },
      {
        title: "Work Cards",
        zh: "卡片显示状态、目录、引擎、实际模型、token、Automation 数量与 Terminal 状态；可直接在 Windows Explorer 或 VS Code 打开 Work，Current Work 支持拖动排序。",
        en: "Cards show status, directory, engine, actual models, tokens, Automation count, and Terminal state; Work directories can open directly in Windows Explorer or VS Code, and Current Work supports persistent drag ordering.",
        href: "/work",
        label: "View cards",
      },
      {
        title: "Execution Settings",
        zh: "执行设置、Settings 和 Execute 恢复 Copilot CLI / Copilot SDK 选择。内置默认 CLI，但尊重用户显式保存的 SDK 默认值。CLI 直接执行本机 copilot -p，不经过 SDK 或 headless RPC；SDK 保留当前会话能力及 MCP blocker。Execute 的覆盖仅作用于当次 Run，每个 Run 冻结真实引擎与设置，不批量改写已有 Work 或历史。Follow Up 继承父 Run 的引擎和 session，而不是下一次 Execute 的选择。布局与切换选项卡时的草稿保持不变。",
        en: "Execution settings, Settings and Execute offer Copilot CLI / Copilot SDK. CLI is the built-in default, while explicitly saved SDK defaults are respected. CLI directly runs the installed copilot -p command without SDK/headless RPC; SDK retains its current controls and MCP blocker. An Execute override affects that Run only; each Run freezes its actual engine/settings without migrating existing Works or history. Follow Up inherits the parent's engine and session, not the next Execute selection. Layout and tab-switch draft preservation remain unchanged.",
      },
      {
        title: "Compact Work Details",
        zh: "Work 详情和该页导航使用可用屏幕宽度，手机保留 16px、较大屏幕保留 24px 边距；左右栏维持原宽，额外空间留给对话，其他页面仍居中。Work 信息、会话视图、Run 状态与快捷操作合并为一条顶部工具栏，吸附在全局导航下。桌面控件高 32px，触控目标至少 44px。默认显示 Conversation；执行设置、Prompt、Run history 在独立侧边选项卡中，窄屏改为横向选项卡。Follow Up 返回对话并聚焦草稿，输入框停靠面板底部，消息独立滚动。长名称可悬停或展开 Work details 查看；历史数量仅表示当前已加载的较早 Run。右侧文件区可展开目录并在新标签页打开文件，窄屏提供 Files 选项卡。",
        en: "Work details and its navigation use the available screen width with 16px mobile / 24px larger-screen gutters. Side columns keep their widths, giving extra space to the conversation; other pages stay centered. Work identity, session views, Run state and shortcuts share a compact toolbar pinned below global navigation. Desktop controls are 32px with at least 44px touch targets. Conversation is the default; execution settings, Prompt and Run history use separate side tabs, horizontal on narrow screens. Follow Up returns to the conversation and focuses its draft; the composer stays at the panel bottom while messages scroll independently. Full titles remain in Work details; history counts only loaded earlier Runs. The right file pane expands folders and opens files in new tabs, with a Files tab on narrow screens.",
      },
      {
        title: "Folder List and Work Name",
        zh: "New work 左侧目录列表随可用列高扩展，列表内部滚动，不会为了显示所有文件夹而无限拉高表单。手机布局保留合理的列表基础高度。Advanced settings 中的 Name 原本只是 Work 显示名，不会重命名磁盘文件夹；该重复输入已移除，新 Work 名称直接由所选目录推导。现有 Work 名称、目录、Prompt 与历史不变。",
        en: "The New work folder list grows with the available directory-column height and scrolls internally instead of stretching the form to fit every folder. Mobile retains a bounded base list height. Advanced Name was only a Work display label, not a disk-folder rename operation; that redundant input is removed and new Work names derive from the selected directory. Existing names, directories, prompts and history are unchanged.",
      },
      {
        title: "Model Availability",
        zh: "主模型与 Fallback 列表使用本机 CLI 支持名单及当前 Copilot 账户的模型目录和 policy。账户未提供、禁用或尚未启用的模型显示 Unavailable，灰色且不可选择；已保存的值仍保留并提示，不自动清空或改成 Auto。读取失败时明确标为 Unverified，保留候选项并可 Retry。目录信息短时缓存，Refresh models 可重新验证。仅查询元数据，不创建推理 Session、不发送收费测试 Prompt；不保证实时配额、网络或上下文/推理参数组合始终可用。Work 与 Automation 的模型选择行为保持一致。",
        en: "Primary and fallback choices combine native CLI support IDs with the current Copilot account catalog and policy. Unlisted, disabled or not-enabled models remain visible as disabled Unavailable options. Saved values are retained with a warning, not cleared or silently changed to Auto. Failed verification explicitly marks choices Unverified with Retry. Metadata is cached briefly; Refresh models rechecks it. No inference session or paid test Prompt is created. Live quota, network and context/reasoning-parameter compatibility are not guaranteed. Work and Automation selectors use the same behavior.",
      },
      {
        title: "Session Conversation",
        zh: "同一 session 的用户与助手消息跨 Run 展示，正文采用 13px 字体与紧凑间距，空正文不生成空白消息卡片。工具与运行元数据按活动归组，执行中展示进度，完成后折叠；失败在摘要可见，技术事件可展开检查。不再重复展示 session Run 列表或 Steering audit 区域，但保留底层历史、审计和当前指令的交付/重试提示。刷新按分页恢复最近历史；若当前 Follow Up 的原始输入位于更早分页，已保存的输入按提交时间显示在后续回复之前，加载原始消息后自动去重，不再追加到时间线底部。保留分页、原始日志和完整 session 下载，不拼接不同 session 或伪造缺失数据。",
        en: "User and assistant turns span linked Runs in the same session, with 13px prose and tighter spacing. Empty prose does not create blank bubbles. Tool/runtime activity opens for progress and folds after completion; failures stay visible and technical events remain inspectable. Duplicate session-Run and Steering-audit panels are removed, not their stored history, audit data or inline delivery/retry feedback. Refresh restores recent history in pages. If the current Follow Up input is in an earlier page, its saved prompt is placed by submission time before later replies and deduplicated when the source message loads, never appended to the timeline bottom. Pagination, raw output and full session download remain available; different sessions and missing data are never merged or invented.",
      },
      {
        title: "In-App Follow Up",
        zh: "CLI Run 运行中允许编辑草稿和准备附件，但不能发送、Steer 或自动排队；结束后无需手动刷新即可手动 Follow Up。新关联 Run 使用父 Run 的引擎及同一原生 session，只发送新内容和新附件，不重放初始 Prompt。SDK 保留实时 Steer。Prompt 追加和同请求重试保持幂等；外部 Terminal 占用、并发 Run 和外部修改冲突仍明确阻止发送。",
        en: "While a CLI Run is active, edit a draft or prepare files but do not send, Steer or auto-queue. Completion enables manual Follow Up without a manual refresh. The linked Run inherits the parent's engine and native session and sends only new content/files, not the initial Prompt again. SDK retains live Steering. Prompt append and same-request retry remain idempotent; external Terminal ownership, concurrent Runs and external-edit conflicts still block sending explicitly.",
      },
      {
        title: "Message Attachments",
        zh: "New work 的 Prompt、Follow Up 与 Steer now 均支持粘贴图片、拖放和选择文件，也可只发送附件。单文件最多 25 MiB，每条最多 10 个、合计 100 MiB。选择时仅在页面本地预览；New work 的三种创建入口均先创建 Work、上传文件并保存 Prompt 引用，再运行或打开 Terminal。失败后冻结草稿，重试复用同一 Work 与上传回执，不重复创建；Create only 后可在 Prompt 选项卡查看附件。初始附件使用 .workboard/attachments/<work-id>/<work-id>/，其余消息使用 <message-id>；无需新增数据库迁移。托管 CLI/SDK 收到真实附件，交互 Terminal 仅收到已保存的相对文件路径，不使用不受支持的交互附件参数。Follow Up/Steer 的同请求重试不重复发送已确认或不确定的 Steering。切换选项卡保留草稿，整页刷新或离开页面不会恢复未发送的 File 对象。文件长期保留，包括失败尝试；备份需包含附件目录、数据库与 Session。不自动执行、解压、安装、作为 Skill 导入或随 Work/实验复制。授权链接支持查看与下载；专用下载支持 25 MiB，普通文件预览仍限 16 MiB。剪贴板支持和模型图片/文档能力因环境而异，传输确认不代表模型已理解。",
        en: "New work Prompts, Follow Up and Steer now accept pasted images, dropped or selected files, including attachment-only input: 25 MiB per file, 10 files and 100 MiB total. Selection creates a page-local preview. All three New work actions create the Work, upload files and save Prompt references before running or opening Terminal. Failure freezes the draft; retry reuses the same Work and receipts instead of creating duplicates. Create only exposes saved attachments in the Prompt tab. Initial files use .workboard/attachments/<work-id>/<work-id>/; later messages use <message-id>. No new database migration is needed. Managed CLI/SDK receive native file attachments; interactive Terminal receives saved relative paths, not unsupported interactive attachment flags. Follow Up/Steer same-request repair never replays accepted or uncertain Steering. Tabs preserve drafts, but full reload/navigation does not restore unsent File objects. Files, including failed attempts, are retained: back up the attachment directory, database and sessions. Files are not executed, unpacked, installed, imported as skills, or included in Work/experiment copies. Owned links allow viewing/download; dedicated downloads support 25 MiB while ordinary preview stays at 16 MiB. Clipboard and model image/document capabilities vary; transport acceptance is not evidence of comprehension.",
      },
      {
        title: "Live Steering",
        zh: "仅活跃 SDK Run 支持 Steer now，即时发送到准确的 Run/session 并保留原有 Prompt、审计和幂等修复。确认不代表模型已应用，不保证停止工具或回滚修改，不确定交付不会自动重发。CLI 使用原生非交互命令，运行中只能编辑待发送草稿，不提供 Steer 或 SDK 控制；后端同样拒绝新增指令。历史已接受指令仍可修复记录但不会重发。CLI 显示原生命令输出和实际进程指标；SDK 保留其原有指标边界。",
        en: "Only an active SDK Run supports Steer now, targeting the exact Run/session with existing Prompt, audit and idempotent-repair safeguards. Acceptance does not prove application, stop tools or roll back edits; uncertain delivery is not replayed. Native CLI is non-interactive: edit an unsent draft during execution, without Steer or SDK controls. The backend rejects new live instructions too. Previously accepted historical records remain repairable without transport replay. CLI shows native command output and process metrics; SDK retains its existing metric limitations.",
      },
      {
        title: "Live Runtime & MCP",
        zh: "此面板仅属于 SDK Run，保留页面内权限审批、Agent 问答、MCP 表单与脱敏连接状态，按钮仍校验用户、主机、Run/session 和策略。SDK 缺少获批 Entra 宿主时保留 Authenticate in Terminal blocker；只有已配置且受支持的认证流程可提供 Sign in。内置 GitHub MCP 沿用 Copilot 账户，已连接服务可 Verify tools。CLI 不显示或调用 SDK 面板，不挂载隐藏的 SDK 会话；原生命令的错误保留在 Conversation 和日志中，不支持的非交互请求明确失败，不自动扩大权限或回退 SDK。两种引擎都不导入其他仓库配置或收集 Token。独立认证失败、MCP 504 及原生 Terminal 专属能力不会因此自动解决。",
        en: "This panel belongs only to SDK Runs, retaining in-page permissions, agent questions, MCP forms and sanitized states. Actions still enforce owner, host, exact Run/session and policy. SDK without approved Entra host configuration retains Authenticate in Terminal; Sign in is offered only for configured, supported flows. Built-in GitHub uses the Copilot account and connected servers retain Verify tools. CLI neither mounts nor invokes the SDK panel or a hidden SDK session. Native errors remain in Conversation/logs; unsupported non-interactive requests fail explicitly without permission escalation or SDK fallback. Neither engine imports foreign repository configuration or collects tokens. Independent authentication failures, MCP 504s and native-Terminal-only capabilities are not automatically solved.",
      },
      {
        title: "Run Startup States",
        zh: "Run 入队后、分配执行主机和 Session 前显示排队或启动中，不将空主机名误报为其他机器。只有已确认的本机活跃 Session 才提供实时操作，明确属于其他主机时仍拒绝访问。PENDING/RUNNING 阶段尚未生成会话历史时显示等待记录，由正常轮询自动恢复，不提示重复启动任务；已结束 Run 缺失历史时仍明确提示原始日志与产物可用。",
        en: "Queued Runs show waiting/starting until their execution host and session are assigned; an empty hostname is not a foreign-machine error. Live actions still require a confirmed local active session, and known foreign hosts remain blocked. Missing recorded history during PENDING/RUNNING is shown as waiting and recovers through normal polling, without suggesting a duplicate Run. Missing history after a Run finishes still reports the original logs and artifacts as available.",
      },
      {
        title: "Live Run Duration",
        zh: "Work 详情、Run 详情、Runs 列表与 Automation 历史中的 RUNNING 时长每秒在页面内更新，不为计时发送网络请求或整页刷新。返回标签页时按实际时间补齐；已结束 Run 保留已记录时长，尚未开始的排队 Run 显示 -。",
        en: "Started RUNNING durations tick every second in Work details, Run details, the Runs list and Automation history, without network requests or page refreshes just to advance time. Returning to the tab catches up to actual elapsed time. Finished Runs retain recorded durations; queued Runs without a start timestamp show -.",
      },
      {
        title: "MCP Microsoft Entra Sign-in",
        zh: "本次分流不是 MCP 认证修复。真实原生 copilot -p 测试中，新 session 的受保护 MCP 调用成功，但同 session --resume 返回 requires authentication；即使命令退出 0，也不能视为该工具成功。此限制如实保留。CLI 使用自己的认证，不读取 WORKBOARD_COPILOT_ENTRA_CLIENT_ID。SDK 缺少获批宿主注册时，needs-auth 服务从首次响应起显示 Authenticate in Terminal，后端也拒绝无效 App 登录；Reload 后保持 blocker，已连接服务保留 Verify tools。在相同目录运行 copilot /mcp 可做 Terminal 诊断，但缓存不保证可复用，不能将 Terminal 成功等同于 App 已认证。SDK 1.0.27+ 可选获批公共客户端注册能力继续保留，不自动注册应用、收集 Token、借用其他应用身份或绕过租户策略。",
        en: "This split is not an MCP authentication fix. Real native copilot -p testing succeeded for a protected MCP in a new session, but same-session --resume returned requires authentication; CLI exit 0 does not prove tool success. That limitation remains explicit. CLI uses its own authentication, not WORKBOARD_COPILOT_ENTRA_CLIENT_ID. SDK without approved host registration shows Authenticate in Terminal from the first needs-auth response and rejects unsupported App login; reload preserves the blocker and connected services retain Verify tools. Local copilot /mcp in the same directory is a Terminal diagnostic, not guaranteed credential sharing or App authentication. Optional approved public-client registration support in SDK 1.0.27+ remains available, without automatic registration, token collection, borrowed identities or tenant-policy bypass.",
      },
      {
        title: "Managed CLI Permissions",
        zh: "原生 CLI 的 Standard tools 使用 --allow-all-tools，仅用户明确选择 Full access 时使用 --allow-all。CLI 不注册 SDK 权限回调，也没有 SDK 审批或问答 UI；非交互模式无法完成的请求明确失败，不偷偷扩大权限。原生命令自行提供的系统登录窗口按 CLI 正常流程工作。SDK 保留现有审批、问答及组织策略处理。更换引擎不会修改已启动 Run 的权限快照，也不代表 MCP 已认证。",
        en: "Native CLI Standard tools uses --allow-all-tools; only an explicit Full access selection uses --allow-all. CLI has no SDK permission callback or SDK approval/question UI. Unsupported non-interactive requests fail explicitly, without hidden escalation. System sign-in windows provided by the native CLI follow its normal flow. SDK retains its existing approval, question and organization-policy handling. Engine selection does not rewrite a started Run's permissions or prove MCP authentication.",
      },
      {
        title: "User Skill Directories",
        zh: "原生 CLI 按本机版本的默认行为自行发现当前用户与 Work 的 Skills，不通过 SDK 注入配置。SDK 创建、恢复和模型回退继续显式读取 Copilot settings.json 的 skillDirectories，优先使用 COPILOT_HOME，否则使用用户 .copilot；格式错误明确报错。两种方式都不修改权限、自动启用 Skill、导入其他仓库配置或修复独立 MCP 超时。",
        en: "Native CLI discovers user/Work Skills using its installed version's normal behavior, without SDK configuration injection. SDK creation, resume and model fallback still read skillDirectories explicitly from Copilot settings.json under COPILOT_HOME or the user's .copilot home; malformed settings report an error. Neither path changes permissions, automatically enables Skills, imports foreign repository configuration or repairs independent MCP timeouts.",
      },
      {
        title: "Archive & Restore",
        zh: "归档不会删除目录、Prompt、Session 或 Run 历史；恢复后可继续运行。",
        en: "Archiving keeps directories, prompts, sessions, and Run history; restore the Work to continue.",
      },
    ],
  },
  {
    id: "prompts-files",
    title: "Prompts & Files",
    subtitle: {
      zh: "Prompt 与资源保留在真实目录中，并具备冲突保护和可移植结构。",
      en: "Prompts and resources remain in real directories with conflict protection and a portable structure.",
    },
    features: [
      {
        title: "Portable Prompt Files",
        zh: "Work 管理 `PROMPT.md` 与 `PROMPT-N.md`。New Work 可读取现有 `Prompt`（无扩展名）、`PROMPT.md` 或编号 Prompt，原文件不会被覆盖。",
        en: "Work manages `PROMPT.md` and `PROMPT-N.md`. New Work can read an existing extensionless `Prompt`, `PROMPT.md`, or numbered Prompt without overwriting the source.",
        href: "/work",
        label: "Read Prompt",
      },
      {
        title: "Auto Load on Path Selection",
        zh: "单击目录、Use current、Browse 或新建/复制成功选定 Work 路径时，自动发现并加载该目录的 Prompt；手动输入路径后可点 Read Prompt。仅浏览另一个根目录不切换已选 Work 或读取其 Prompt；多个文件可在选择器中切换。",
        en: "Selecting a Work path through a folder, Use current, Browse, creation or copying discovers and loads its Prompt. After typing a path, use Read Prompt. Browsing another root alone does not change the selected Work or import its Prompt; choose among multiple files from the selector.",
      },
      {
        title: "Autosave & Conflict Detection",
        zh: "Work 详情中的编辑器自动保存，并使用内容 hash 防止覆盖外部修改。",
        en: "The Work detail editor autosaves and uses content hashes to avoid overwriting external edits.",
      },
      {
        title: "Prompt Templates",
        zh: "内置与自定义模板支持 Append/Replace；Settings 可创建、编辑、删除或导入 Markdown、text 与 prompt 文件。",
        en: "Built-in and custom templates support Append/Replace; Settings can create, edit, delete, or import Markdown, text, and prompt files.",
        href: "/settings#prompt-templates",
        label: "Manage templates",
      },
      {
        title: "Common Roots & Explorer",
        zh: "保存常用根目录、浏览直接子目录、在当前目录创建并自动选择新文件夹，以及在 Windows Explorer 打开根目录、子目录或 Work。下拉框按用户在当前浏览器记住上次选择，刷新或重启后恢复；已删除的快捷目录回退到第一项，恢复根目录不会自动选择 Work 路径或读取 Prompt，清除站点存储会重置此偏好。后台更新和窗口焦点刷新不会清空目录列表或中断加载，可用目录刷新按钮重新读取。Work Card 还可直接在 VS Code 打开目录。",
        en: "Save common roots, browse immediate children, create and select a new child folder, and open roots, child folders, or Works in Windows Explorer. The dropdown remembers the last selection per user in this browser across refreshes and restarts; removed shortcuts fall back to the first root. Restoring a root does not select a Work path or read its Prompt, and clearing site storage resets the preference. Background updates and window-focus refreshes preserve the folder list and in-flight loading; use the directory refresh button to reload. Work cards can also open their directory directly in VS Code.",
        href: "/settings",
        label: "Manage paths",
      },
      {
        title: "Portable Directory Layout",
        zh: "`.workboard/` 保存 manifest、Run 输出、variants 与 `attachments/<work-id>/<message-id>/`。附件留在所属 Work，Work/实验复制和托管 Git 快照排除它；不自动删除，备份时应保留。",
        en: "`.workboard/` stores manifests, Run outputs, variants and `attachments/<work-id>/<message-id>/`. Attachments stay in the owning Work and are excluded from Work/experiment copies and managed Git snapshots; retain them in backups because there is no automatic deletion.",
      },
    ],
  },
  {
    id: "runs-sessions",
    title: "Runs & Sessions",
    subtitle: {
      zh: "Run 是不可变的执行记录，包含设置、状态、输出、diff、资源统计和 Session 关系。",
      en: "A Run is an immutable execution record containing settings, status, output, diffs, resource metrics, and session lineage.",
    },
    features: [
      {
        title: "Runs Ledger",
        zh: "Runs 页面按状态筛选并显示 owner、trigger、机器、开始时间、时长、PID 与取消入口。",
        en: "The Runs page filters by status and shows owner, trigger, machine, start time, duration, PID, and cancellation controls.",
        href: "/runs",
        label: "Open Runs",
      },
      {
        title: "Live Output & Process Info",
        zh: "Run 详情优先显示 Result 与 Output，通过 SSE 与轮询同步日志；状态单独读取轻量元数据，首次响应、定时轮询与回到页面都会检查，不依赖对话加载或打开 Raw output。仓库、分支、机器、关联 Run 与 Process Info 收进默认折叠的 Run details；状态、托管 Run 的取消与错误提示保持可见，展开信息不会因当前页面自动刷新而收起。Process Info 保持挂载并显示 PID、CPU、内存及冻结的执行设置。",
        en: "Run pages prioritize Result and Output, with SSE and polling for logs. Separate lightweight metadata checks refresh status on the first response, periodically, and on focus, independently of conversation loading or opening Raw output. Repository, branch, host, related Runs, and Process Info move into Run details, initially closed; status, managed cancellation, and errors stay visible, and same-page automatic refreshes preserve expansion. Process Info stays mounted with PID, CPU, memory, and frozen execution settings.",
      },
      {
        title: "Completion Integrity",
        zh: "CLI exit code 0 不等于完成。仍有 tool/sub-agent、发生取消或缺少根级最终回复时，会恢复同一 Session 最多三次，然后明确失败。",
        en: "CLI exit code 0 does not imply completion. Open tools/sub-agents, cancellations, or a missing root response resume the same session up to three times before an explicit failure.",
      },
      {
        title: "Results & Artifacts",
        zh: "Result 使用安全的 GitHub Flavored Markdown 渲染。每个 Run 可下载 result、transcript、diff、run snapshot、stdout 和 stderr。",
        en: "Results render safe GitHub Flavored Markdown. Every Run exposes result, transcript, diff, Run snapshot, stdout, and stderr downloads.",
      },
      {
        title: "Model & Token Usage",
        zh: "Session 结束后记录实际模型，以及 input、output、cache read/write 和 reasoning tokens；Work 卡片显示摘要。",
        en: "After session shutdown, actual models plus input, output, cache read/write, and reasoning tokens are recorded and summarized on Work cards.",
      },
      {
        title: "Terminal Start, Resume & Sync",
        zh: "首次运行可创建交互 Session；完成 Run 可恢复同一 Session。每分钟同步已写入的历史，停止并稳定一分钟后收口，不再使用 callback 或手工 Sync。",
        en: "Create or resume an interactive session. Persisted history syncs every minute; stopped sessions settle after a minute of stable history, without callbacks or manual Sync.",
      },
      {
        title: "Terminal Activity & Settlement",
        zh: "Work 卡片、Work 详情与 Run 详情统一显示状态：IN TERMINAL 表示仍在运行或启动；浅绿色 SYNCING 表示 Terminal 已停止，历史尚在收口；缺少完成证据时显示浅绿色 TERMINAL（内部 UNKNOWN），不会因关闭窗口就判成功。Resume 与对话区 Follow Up 可先尝试安全收口，再检查 Session 锁、历史、源状态及冲突；失败会明确提示并保留输入。无法确认活动状态时不开放 Resume。",
        en: "Work cards and both detail pages use consistent status: IN TERMINAL means active or starting; light-green SYNCING means stopped with history settlement pending. Missing completion evidence shows light-green TERMINAL (internally UNKNOWN), never success just because a window closed. Resume and inline Follow Up may safely settle the parent first, then check session locks, history, source state, and conflicts. Failures stay explicit and retain the draft; unverified activity does not unlock Resume.",
      },
      {
        title: "Recovery & Cancellation",
        zh: "应用重启会恢复 PENDING Run、收口中断 Run，并补同步活动和 UNKNOWN Terminal 历史；运行中的 Terminal 可持续同步，不因超过 24 小时被判为 UNKNOWN。应用内 Cancel 只用于托管 Run；外部 Terminal 必须在 Terminal 中停止，随后自动同步。",
        en: "Restart recovery requeues pending Runs, finalizes interrupted Runs, and catches up active and UNKNOWN Terminal histories. Active sessions keep syncing without a 24-hour callback expiry. In-app Cancel is for managed Runs only; stop external sessions in Terminal and their history synchronizes automatically.",
      },
    ],
  },
  {
    id: "automations",
    title: "Automations",
    subtitle: {
      zh: "面向重复工作和外部触发的可持续任务系统。",
      en: "A persistent task system for repeatable work and external triggers.",
    },
    features: [
      {
        title: "Triggers",
        zh: "支持手动、cron schedule、GitHub webhook 和 Bearer token API 四类触发方式。",
        en: "Supports manual, cron schedule, GitHub webhook, and bearer-token API triggers.",
        href: "/tasks",
        label: "Open Automations",
      },
      {
        title: "Inline Resources",
        zh: "创建 Automation 时可选择、添加、编辑或删除 Resource，无需单独管理工作区。",
        en: "Choose, add, edit, or remove a Resource while creating an Automation, without a separate resource workspace.",
        href: "/tasks/new",
        label: "New Automation",
      },
      {
        title: "Safe Git Execution",
        zh: "可同步默认分支、创建安全分支、冻结 base/final commit，并生成稳定 diff。",
        en: "Synchronize the default branch, optionally create a safe branch, freeze base/final commits, and produce stable diffs.",
      },
      {
        title: "Queue & Timeout",
        zh: "同 Resource 的 Run 串行执行；可选择等待所有更早 Run，并配置独立 timeout。",
        en: "Runs sharing a Resource serialize; optionally wait for all earlier Runs and configure an independent timeout.",
      },
      {
        title: "Webhook & API Security",
        zh: "GitHub webhook 使用 HMAC secret 验证；外部 API 使用只显示一次的 token，并记录最后使用时间。",
        en: "GitHub webhooks verify HMAC secrets; the external API uses one-time-visible tokens and records last use.",
        href: "/settings",
        label: "Manage integrations",
      },
    ],
  },
  {
    id: "experiments-skills",
    title: "Experiments & Skills",
    subtitle: {
      zh: "在同一冻结基线下比较 Skill 对完整任务执行的影响。",
      en: "Compare how Skills affect complete task execution from the same frozen baseline.",
    },
    features: [
      {
        title: "Skill Discovery",
        zh: "Skill comparison 创建区域默认隐藏；在 .env 设置 `WORKBOARD_SHOW_SKILL_COMPARISON=true` 并重启后，可在 Comparisons 选项卡创建比较。发现项目 `.github/skills`，也可添加本地 Skill 目录并校验 hash。开关只影响创建界面及初始扫描，不禁用已有结果或后台 API。",
        en: "The Skill comparison builder is hidden by default. Set `WORKBOARD_SHOW_SKILL_COMPARISON=true` in .env and restart to create comparisons in the Comparisons tab. Discover project `.github/skills` or add a local directory with hash verification. The switch controls only the creation UI and initial scan, not existing results or APIs.",
      },
      {
        title: "Frozen Variants",
        zh: "先复制一次完整 baseline，再为每个 Skill 与可选 no-Skill baseline 创建隔离 variant。",
        en: "Copy one complete baseline, then create an isolated variant per Skill plus an optional no-Skill baseline.",
      },
      {
        title: "Invocation Modes",
        zh: "Explicit 模式在 Prompt 中指定 `/skill-name`；Auto 模式让 Copilot 自主选择。CLI 与 SDK 均可用于实验。",
        en: "Explicit mode names `/skill-name` in the Prompt; Auto mode lets Copilot choose. Experiments support both CLI and SDK.",
      },
      {
        title: "Comparison Results",
        zh: "Work 详情显示 variant 状态、Skill hash、是否调用 Skill、Markdown 结果预览和完整 artifacts 链接。",
        en: "Work details show variant state, Skill hash, whether the Skill was invoked, Markdown result previews, and complete artifact links.",
      },
      {
        title: "Aggregate Notification",
        zh: "所有 variants 收敛后只发送一条系统通知，避免并行实验产生多条干扰。",
        en: "One system notification is emitted after every variant settles, avoiding notification storms from parallel experiments.",
        href: "/settings#notifications",
        label: "Notification settings",
      },
    ],
  },
  {
    id: "settings-auth",
    title: "Settings & Auth",
    subtitle: {
      zh: "集中管理默认执行行为、本地集成和访问边界。",
      en: "Manage default execution behavior, local integrations, and access boundaries in one place.",
    },
    features: [
      {
        title: "Execution Defaults",
        zh: "设置新 Work 与 Automation 的共享默认值；已存在项目继续使用自己的冻结配置。",
        en: "Set shared defaults for new Work and Automations; existing items retain their saved configuration.",
        href: "/settings#execution-defaults",
        label: "Execution defaults",
      },
      {
        title: "System Notifications",
        zh: "成功、失败、超时通知默认开启，可关闭或发送测试。Windows 首次发送登记当前用户的 Work Board 通知身份，不涉及开机自启；外框和主题由系统控制。点击测试通知打开此设置页；链接使用 AUTH_URL（默认 localhost:3100）。已提交不等于横幅已显示，系统勿扰/通知权限仍有效；原生错误明确提示，macOS/Linux 保留现有能力。",
        en: "Success, failure and timeout notifications default on; disable them or submit a test. Windows prepares a current-user Work Board identity, not login startup; native frames/themes remain OS-controlled. Selecting the test opens Settings; links use AUTH_URL (localhost:3100 by default). Submitted does not mean a banner was shown: OS policy still applies and native errors stay explicit. macOS/Linux retain existing capabilities.",
        href: "/settings#notifications",
        label: "Notification settings",
      },
      {
        title: "Authentication Modes",
        zh: "Entra ID 与 secret 同时配置时要求 Microsoft 登录；两者都为空时，仅在 loopback 启用免登录 Local mode。",
        en: "Configure both Entra ID and secret to require Microsoft sign-in; leave both empty for login-free loopback-only local mode.",
      },
      {
        title: "Templates, Paths & Integrations",
        zh: "管理 Prompt templates、Work root shortcuts、GitHub webhooks 和 API tokens。",
        en: "Manage Prompt templates, Work root shortcuts, GitHub webhooks, and API tokens.",
        href: "/settings",
        label: "Open Settings",
      },
      {
        title: "Global Search & Theme",
        zh: "导航栏可搜索 Work、Resource、Automation 和 Run ID；主题首次跟随系统，之后保存用户选择。",
        en: "Search Work, Resources, Automations, and Run IDs from the nav; theme follows the OS initially and then persists your choice.",
      },
    ],
  },
  {
    id: "operations",
    title: "Operations",
    subtitle: {
      zh: "保持后台进程运行，并理解本地优先架构的安全和可靠性边界。",
      en: "Keep the background process alive and understand the security and reliability boundaries of the local-first architecture.",
    },
    features: [
      {
        title: "Background Commands",
        zh: "使用 `background:start`、`restart`、`status`、`logs` 和 `stop` 管理后台 Release；代码、依赖或 migration 变化后使用完整 restart。start/restart 成功后按配置登记登录自启；显式 stop 即使服务已停止也移除自启项。",
        en: "Use `background:start`, `restart`, `status`, `logs`, and `stop` for the background Release; use a full restart after code, dependencies, or migrations change. Successful start/restart reconciles login startup; explicit stop removes it even when already stopped.",
      },
      {
        title: "Run Concurrency",
        zh: "RUN_CONCURRENCY 默认 5，限制单个服务进程同时执行的队列 Run 数，其余排队；同 key 串行和独占等待可能降低实际并发。只使用正整数，目前没有硬性上限或严格校验；按 CPU、内存、费用和服务限流调整。修改 .env 后重启，不限制单个 Run 内的工具/子代理或手动 Terminal 会话。",
        en: "RUN_CONCURRENCY defaults to 5 queued Runs at once per server process; others wait. Same-key serialization and exclusive waiting can reduce actual concurrency. Use positive integers only: there is no hard cap or strict validation. Adjust to CPU, memory, cost and service limits, then restart after editing .env. It does not cap tools/subagents inside a Run or manual Terminal sessions.",
      },
      {
        title: "Login Autostart",
        zh: "`WORKBOARD_AUTOSTART` 未配置或为空时默认 true，false 允许手动启动但禁用登录自启。支持 Windows 当前用户隐藏启动、macOS LaunchAgent、Linux systemd 用户服务，不提权、不改 linger。登录只启动已构建 Release，不构建、迁移、打开浏览器或提交新指令；无崩溃自动拉起，macOS 退出登录时结束，Linux 已有 linger 可能使用户服务在开机时启动。",
        en: "`WORKBOARD_AUTOSTART` defaults to true when unset/empty; false permits manual startup but disables login startup. Supports hidden Windows current-user startup, macOS LaunchAgents, and Linux systemd user services without elevation or linger changes. Login only starts a prepared Release: no build, migration, browser, new instruction, or crash restart. macOS ends at logout; existing Linux linger can start the user manager at boot.",
      },
      {
        title: "Autostart Status & Recovery",
        zh: "`autostart:status` 只读检查配置意图和实际登记；`sync` 应用开关，`remove` 仅移除登记，不停止运行中的服务，配置错误也可清理。stop/remove 后仅改 true 不会恢复系统项，需显式登记。后台启动成功但登记失败会保留服务。旧脚本的 Cannot inspect Run entry 可能是 Windows PowerShell 5.1 将不存在的值序列化为空输出，更新脚本用明确对象区分缺失、有效值和真正错误，无需重启应用；status 不会自动登记，只有打算修改本机项时才执行 sync。保留 WSH、ACL、冲突等检查；勿删除其他启动项。Linux 仍需可用的 systemd 用户会话。",
        en: "`autostart:status` reads intent and registration; `sync` applies policy and `remove` unregisters without stopping a running server, even with an invalid flag. After removal, true alone cannot recreate an entry; explicit registration is required. A started server stays running if registration fails. Older Cannot inspect Run entry errors can come from Windows PowerShell 5.1 emitting no JSON for a missing value. Updated scripts use a validated object to distinguish absence, values and real errors without an application restart. Status never registers anything; run sync only when you intend to change this machine's entry. WSH, ACL and conflict checks remain; never remove other entries. Linux still needs a working systemd user session.",
      },
      {
        title: "Scheduler & Keep Awake",
        zh: "Node 进程负责 cron scheduler，并在 Windows/macOS 上默认防止空闲休眠；服务器停止或休眠期间不会补跑错过的 schedule。",
        en: "The Node process owns cron scheduling and prevents idle sleep by default on Windows/macOS; missed schedules are not replayed after downtime or sleep.",
      },
      {
        title: "Startup Recovery",
        zh: "启动时依次恢复 Run、回收 Terminal launch、分发通知 backlog，再启动 scheduler。",
        en: "Startup recovers Runs, reaps Terminal launches, dispatches the notification backlog, and only then starts the scheduler.",
      },
      {
        title: "Data & Backup",
        zh: "备份应包括 DATABASE_URL 对应的 SQLite、应用 data/ 与后台日志，各 Work 的 Prompt、资源和 `.workboard`（含附件），以及 COPILOT_HOME（默认 ~/.copilot）下的会话历史。不能只备份数据库或输出日志来代替原始附件与 session 历史。",
        en: "Back up SQLite at DATABASE_URL, app data/logs, each Work's prompts/resources and `.workboard` including attachments, and conversation history under COPILOT_HOME (default ~/.copilot). Database or output-log backups alone do not replace original attachments and session history.",
      },
      {
        title: "Source Updates & Migrations",
        zh: "Latest source 不表示运行中的后台版本已更新。附件功能新增 Run/Steering 可空元数据列，升级时先停旧服务、应用 migration，再构建并启动；旧记录无需补附件。登录自启不代做迁移或构建，自启脚本修复本身无需重启应用。",
        en: "Latest source does not mean a background instance is current. Attachments add nullable Run/Steering metadata: stop the old server, apply migrations, then build/start; older records need no attachments. Login startup does not migrate or build, and an autostart-script-only fix needs no application restart.",
      },
      {
        title: "Single-Host Boundary",
        zh: "系统面向单台可信机器和单个 Next.js 实例，不提供跨副本分布式锁。Terminal、Explorer 和系统通知作用于运行服务的主机。",
        en: "The system targets one trusted machine and one Next.js instance, without distributed locking. Terminal, Explorer, and OS notifications act on the server host.",
      },
      {
        title: "Directory Concurrency",
        zh: "同目录并发可能混合修改和 diff；需要归因隔离时使用编号副本或 Experiment variants。",
        en: "Concurrent work in one directory can mix changes and diffs; use numbered copies or Experiment variants when attribution matters.",
      },
    ],
  },
];

export const operationalLimits: BilingualText[] = [
  {
    zh: "New work 名称栏仅引用已选目录的直接子项名称，不递归读取或上传；Prompt、Follow Up / Steer now 的 Add files、粘贴和拖放才保存真实附件。",
    en: "The New work strip inserts only immediate names from the selected directory, without recursively reading or uploading files. Add files, paste and drop in Prompt, Follow Up / Steer now save actual attachments.",
  },
  {
    zh: "消息附件单文件 25 MiB、每条最多 10 个/100 MiB；专用附件下载支持完整 25 MiB，普通文件预览仍限 16 MiB。传输确认不代表所选模型已理解内容；整页刷新不恢复未发送的浏览器文件草稿。",
    en: "Message attachments allow 25 MiB per file, 10 files and 100 MiB per message. Dedicated downloads support 25 MiB; ordinary previews remain limited to 16 MiB. Acceptance is not model comprehension, and a full reload does not restore unsent browser-file drafts.",
  },
  {
    zh: "First Run in Terminal 只在 Work 尚无任何 Run 时可用，并要求 Windows 与本机/受信任访问。",
    en: "First Run in Terminal is available only before a Work has any Run and requires Windows plus local or explicitly trusted access.",
  },
  {
    zh: "系统通知采用 at-most-once claim；极端情况下若进程在 claim 后崩溃，可能漏一条，但不会重复。",
    en: "System notifications use at-most-once claims; a crash after claim can lose one toast, but it will not be duplicated.",
  },
  {
    zh: "外部 Terminal 历史每分钟同步，需要服务持续运行。停止后通常 1–2 分钟收口，期间显示 SYNCING 而不是 RUNNING；缺少退出码和完整完成证据时显示 TERMINAL（内部 UNKNOWN），后续可恢复。VS Code 按钮目前仅打开目录，不自动关联原生 Chat session。",
    en: "Terminal histories sync every minute while the server runs. Stopped sessions usually settle within 1–2 minutes, showing SYNCING rather than RUNNING meanwhile. Missing exit codes and incomplete evidence show TERMINAL (internally UNKNOWN) for later recovery. VS Code currently opens the folder only, without native Chat session tracking.",
  },
  {
    zh: "大型目录复制会包含依赖、build output、隐藏文件和 Git metadata；执行前检查磁盘空间。",
    en: "Large folder copies include dependencies, build output, hidden files, and Git metadata; check disk capacity first.",
  },
  {
    zh: "SQLite 数据库包含 session、webhook secret 与 token hash，应视为敏感本地数据。",
    en: "The SQLite database contains sessions, webhook secrets, and token hashes and should be treated as sensitive local data.",
  },
];

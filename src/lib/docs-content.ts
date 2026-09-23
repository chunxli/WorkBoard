export interface BilingualText {
  zh: string;
  en: string;
}

export interface DocsFeature extends BilingualText {
  title: string;
  href?: string;
  label?: string;
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
    date: "2026-09-04",
    version: "Latest changes",
    status: "latest",
    title: {
      zh: "最新源码功能",
      en: "Latest source changes",
    },
    notes: [
      {
        title: "First Run in Terminal",
        zh: "创建 Work 时可直接打开 Windows Terminal，用已保存 Prompt 启动全新的交互式 Copilot Session。",
        en: "Create a Work and immediately open a new interactive Copilot session from its saved Prompt.",
      },
      {
        title: "Background System Notifications",
        zh: "Work、Automation 和聚合 Experiment 在成功、失败或超时时发送主机系统通知；关闭全部浏览器标签后仍有效。",
        en: "Host OS notifications now cover successful, failed, and timed-out Work and Automation Runs, plus aggregate Experiments, even with every browser tab closed.",
      },
      {
        title: "Stable Process Info",
        zh: "实时 CPU 与内存轮询不再覆盖冻结的 model、fallback、权限与 timeout 设置，也不会因请求乱序倒退。",
        en: "Live CPU and memory polling no longer overwrites frozen model, fallback, permission, or timeout settings, and responses cannot regress out of order.",
      },
      {
        title: "Terminal Lifecycle Hardening",
        zh: "Terminal callback、手工 Sync、过期回收和重启恢复共用更严格的状态收口，并保留真实退出码。",
        en: "Terminal callbacks, manual Sync, expiry reaping, and restart recovery now converge through stricter lifecycle checks with the real exit code preserved.",
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
        title: "Create Actions",
        zh: "Create only 只保存；Create & Run 在应用内启动 Run；Create & Open Terminal 用保存后的 Prompt 启动第一个交互式 Terminal Session。",
        en: "Create only saves; Create & Run starts an in-app Run; Create & Open Terminal starts the first interactive Terminal session from the saved Prompt.",
        href: "/work",
        label: "Create Work",
      },
      {
        title: "Work Cards",
        zh: "卡片显示状态、目录、引擎、实际模型、token、Automation 数量与 Terminal 状态；Current Work 支持拖动排序。",
        en: "Cards show status, directory, engine, actual models, tokens, Automation count, and Terminal state; Current Work supports persistent drag ordering.",
        href: "/work",
        label: "View cards",
      },
      {
        title: "Execution Settings",
        zh: "每个 Work 可独立选择 CLI/SDK、agent、主/备用模型、context、reasoning effort、权限、输出格式和可选 timeout；每个 Run 冻结当次设置。",
        en: "Each Work independently configures CLI/SDK, agent, primary/fallback models, context, reasoning effort, permissions, output format, and optional timeout; every Run freezes its settings.",
      },
      {
        title: "In-App Follow Up",
        zh: "Work 空闲后可追加 Prompt。已有兼容 Session 时恢复最新 Session；没有历史 Session 时自动创建，并建立父子 Run 链。",
        en: "Append another Prompt after the Work becomes idle. Resume the latest compatible session or create the first session automatically, with parent/child Run lineage.",
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
        zh: "从目录浏览器或常用根目录切换路径时，自动发现并加载对应 Prompt；多个文件可在选择器中切换。",
        en: "Selecting a path from the browser or common roots automatically discovers and loads its Prompt; switch among multiple files from the selector.",
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
        zh: "保存常用根目录、浏览直接子目录、在当前目录创建并自动选择新文件夹，以及在 Windows Explorer 打开根目录、子目录或 Work。",
        en: "Save common roots, browse immediate children, create and select a new child folder, and open roots, child folders, or Works in Windows Explorer.",
        href: "/settings",
        label: "Manage paths",
      },
      {
        title: "Portable Directory Layout",
        zh: "`.workboard/` 保存 manifest、Runs 和 variants；复制 Work 时排除该目录，避免递归复制。",
        en: "`.workboard/` stores manifests, Runs, and variants; Work copies exclude it to prevent recursive copies.",
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
        zh: "详情页通过 SSE 与轮询同步日志和状态；Process Info 稳定显示 PID、CPU、内存及冻结的执行设置。",
        en: "Run details synchronize logs and state through SSE and polling; Process Info consistently shows PID, CPU, memory, and frozen execution settings.",
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
        zh: "首次运行可创建新交互 Session；完成 Run 可恢复同一 Session。Terminal 退出后 callback 自动同步，失败时可手工 Sync。",
        en: "A first Run can create a new interactive session; completed Runs can resume it. Terminal exit callbacks sync automatically, with manual Sync as a fallback.",
      },
      {
        title: "Recovery & Cancellation",
        zh: "应用重启会恢复 PENDING Run、收口中断 Run，并回收过期 Terminal launch；活动 Run 可取消，外部 Terminal 需先关闭再同步。",
        en: "Restart recovery requeues pending Runs, finalizes interrupted Runs, and reaps expired Terminal launches; live Runs can be cancelled, while external Terminal sessions must close before Sync.",
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
        zh: "发现项目 `.github/skills`，也可添加任意本地 Skill 目录并校验内容 hash。",
        en: "Discover project `.github/skills` or add any local Skill directory with content-hash verification.",
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
        zh: "默认开启成功、失败、超时通知，可关闭或发送测试通知；toast 显示在运行后台进程的主机。",
        en: "Success, failure, and timeout notifications are enabled by default; disable them or send a test toast on the background host.",
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
        zh: "使用 `background:start`、`restart`、`status`、`logs` 和 `stop` 管理 detached release；代码、依赖或 migration 变化后使用完整 restart。",
        en: "Use `background:start`, `restart`, `status`, `logs`, and `stop` to manage the detached release; use a full restart after code, dependency, or migration changes.",
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
        zh: "SQLite、session 与后台日志位于应用目录；Prompt、资源和 `.workboard` artifacts 位于各 Work 目录。备份时应保留两部分。",
        en: "SQLite, sessions, and server logs live with the app; prompts, resources, and `.workboard` artifacts live in each Work directory. Back up both.",
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
    zh: "First Run in Terminal 只在 Work 尚无任何 Run 时可用，并要求 Windows 与本机/受信任访问。",
    en: "First Run in Terminal is available only before a Work has any Run and requires Windows plus local or explicitly trusted access.",
  },
  {
    zh: "系统通知采用 at-most-once claim；极端情况下若进程在 claim 后崩溃，可能漏一条，但不会重复。",
    en: "System notifications use at-most-once claims; a crash after claim can lose one toast, but it will not be duplicated.",
  },
  {
    zh: "外部 Terminal 必须通过 callback 或手工 Sync 收口；没有退出码就过期的 callback 会将 Run 标为 UNKNOWN，而不是 FAILED，之后仍可同步。",
    en: "External Terminal Runs must converge through callback or manual Sync; when a callback expires without an exit code, the Run is marked UNKNOWN rather than FAILED and can be synchronized later.",
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

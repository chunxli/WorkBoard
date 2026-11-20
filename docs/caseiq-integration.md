# CaseIQ 集成说明

## 阅读导航

网页入口为 `/docs` → **CaseIQ Guides** → **CaseIQ integration**；操作指南与原生协议均直接读取仓库 Markdown，不复制维护另一份能力或测试状态。网页标题支持锚点跳转，代码块可复制；普通 CLI/SDK 的行为不因阅读文档而改变。

- [当前状态](#当前状态摘要)
- [真实网页复测](#真实网页复测)
- [站内文档与维护](#站内文档与维护)
- [网页运行流程](#网页运行流程)
- [同一 Work 双 Session](#同一-work-双-session)
- [Conversation 无输出时](#conversation-无输出时)
- [SupportIQ 认证与临时终端](#supportiq-认证与临时终端)
- [Windows keyring 资源错误](#windows-keyring-资源错误)
- [npm 12 跨 registry 下载限制](#npm-12-跨-registry-下载限制)
- [PowerShell 宿主与长路径](#powershell-宿主与长路径)
- [CaseIQ 收尾目录重命名](#caseiq-收尾目录重命名)
- [网页 Runtime 回归与边界](#网页-runtime-回归与边界)
- [本轮细节优化](#本轮细节优化)
- [旧 Terminal 使用与兼容](#首次使用从注册到原生会话)
- [安装注册与部署](#安装注册与部署)
- [旧 Terminal 最近会话与设置复用](#最近-caseiq-会话与设置复用)
- [旧 Terminal 启动回执和重复请求](#启动回执错误和重复请求防护)
- [故障排查与停用/回退](#结果与故障处理)
- [数据、认证与备份](#会话数据与认证)
- [验证结果及剩余限制](#验证方式与剩余限制)
- [实现模块与依赖边界](#已落地的模块解耦)
- [原生 bridge 技术协议](caseiq-native-bridge.md#private-protocol)

## 当前状态摘要

**当前主入口是普通 Work 表单里的 Runtime → CaseIQ：使用用户自己的 Prompt，通过 Create & Run / Execute 在网页运行，输出与后续消息留在 WorkBoard，不默认打开 Terminal。它调用原始 CaseIQ 启动器，不是把普通 CLI 的 Agent 字段改成 caseiq。**

网页执行链路现已完成原始 CaseIQ 启动器、真实原生 CLI 和 `gpt-6.1-sol` 的合成文本执行/Follow Up 验证，真实输出回到 Conversation，历史、Pins 和下载可用。这不等于客户案件、所有企业 MCP 或遥测逐次送达均已验证；旧 Terminal 入口仅保留历史兼容。

| 项目 | 当前状态 |
|---|---|
| 已实现 | Runtime 选择 CaseIQ、用户 Prompt 网页执行、流式输出、附件、同 Provider Follow Up/Queue、取消/超时与原生历史/Pins；旧 Terminal 会话保留兼容 |
| 职责解耦 | 只读安装、纯身份、共享错误、私有绑定、原生生命周期分层；只读安装模块不依赖 Prisma、私有 session 存储或生命周期模块 |
| 宿主注册 | 环境变量模式不读取被忽略的 JSON；JSON 支持 UTF-8 BOM；配置错误明确返回不可用，错误报告不再次读文件 |
| 进程归属 | 网页 Run 跟踪所属隐藏包装进程并通过关联控制记录取消；停止未确认时继续占用 Work。旧 Terminal 仍校验 PID＋精确创建标识 |
| 只读检查性能 | 同一进程内合并进行中的检查，只复用不可变 commit 的包 ID 索引；手动刷新及启动/Resume 不使用过期就绪结论 |
| 最近真实只读探测 | 103 个支持包与冻结 commit 的合规 manifest 集合逐一匹配；不启动 CaseIQ 或模型 |
| 网页执行回归 | 执行器 18 项回归、PowerShell 宿主 5 项、finalHome 收尾 6 项通过；CaseIQ/原生身份相关 159 项全部通过 |
| 文档与 Markdown 回归 | 41 项全部通过，覆盖站内导航、两份原文的目录锚点、认证、双向链接、代码复制及普通对话兼容 |
| Conversation 输出回归 | 100 项相关测试全部通过，覆盖启动输出、历史接管、同 Provider 续跑及关联收尾位置 |
| 上一阶段完整套件（2 个 worker） | 1147 项：1140 通过、4 跳过、3 项原有基线失败；CaseIQ 159 项、Conversation 100 项、Docs 41 项全部通过（分组有交集）；新认证入口的目标回归单独记录 |
| 构建和交付 | 类型、lint 和生产构建通过；保留 2 项原有 lint warning 与动态 trace warning。独立测试输出复核 76 份 trace，私有引用和外部 CaseIQ 源码均为 0，原生认证观察脚本保留 |
| 仍未开放 | SDK 专属实时 Steering/审批面板、自动回答原生认证或审批、网页取消旧外部终端、CaseIQ 定时自动化、独立旧历史自动导入 |
| SupportIQ 手动认证入口 | CaseIQ Conversation 显示 **Sign in to SupportIQ**；确切的 `/mcp auth SupportIQ` 也走独立认证接口，不发给模型、不创建普通 Run |
| 认证体验 | 显式勾选可预先信任当前 Work 的准确目录；登录按钮自动复制认证命令；Refresh 显示关联的原生连接/工具验证结果，并收起已完成的登录提示 |
| 原生认证状态 | 合成 Session 已取得真实 `connected` 和非空 live `tools/list` 回执，验证 10 个工具；自动输入命令和自动成功关窗仍未实现，不提升 Full access |
| 本轮认证与指南回归 | 9 个测试文件、127 项全部通过，覆盖 scoped trust、原生连接回执、占用恢复/观察目录清理、UI 及两份指南的目录与读取；类型、目标 lint、独立生产构建通过 |
| MCP 工具执行授权 | Conversation 的 **MCP tool approvals** 按服务分组，覆盖原生会话实际请求过的 MCP；每组可逐项/批量批准，或单独开启默认关闭的自动模式；仅当前 Work/Session 的未来 Run 生效，保留原 SupportIQ 设置 |
| 尚需人工验证 | 每个真实用户 Work 的 TSE/企业 MCP 授权、真实案件工具链、repository hooks 就绪、必需工具与遥测逐运行送达；合成 Session 的 MCP 连通不证明全部就绪 |
| 回退原则 | 网页运行失败留在网页显示原因，不自动打开 Terminal，不转裸 Copilot/SDK，不自动重放未知请求，不无证据释放占用 |
| 源码与上线边界 | 只修改 WorkBoard；CaseIQ 源码未改。实际服务实例需在确认运行任务安全后重启，不能只构建后假设旧实例已更新 |

## 真实网页复测

本轮在独立空 Work 目录中，通过正常 Runtime → CaseIQ → Create & Run / Run Work / Follow Up 界面执行真实启动器与 CLI **1.0.107**、模型 **gpt-6.1-sol**。没有查询客户案件、运行模型生成的 shell/浏览器操作或修改 CaseIQ 源码；记录的模型工具调用为 0。后台响应未做 mock；隐藏的集成浏览器只模拟页面可见性以驱动真实界面轮询与交互。

| 检查 | 实际结果 |
|---|---|
| 初次真实启动 | PowerShell 5.1 将已生成的 264 字符 MCP 路径判成不存在，模型未启动；已改为核对过的 PowerShell 7 |
| 首次模型返回 | 原生已返回标记，但 CaseIQ 收尾改名导致 WorkBoard 读旧 home 并误报失败；已增加关联、不可覆盖的 finalHome 记录 |
| 修复后正常网页 Run | SUCCESS、退出码 0、正确返回合成标记、原生历史可读 |
| 首个 Follow Up | 同 Session、最终 home 和原生 Resume 验证通过，模型完成但拒答“复述标记”提示；**不计为上下文回忆正确** |
| 普通算术 Follow Up | SUCCESS、退出码 0，同 Session 正确回答 `7 + 5 = 12` |
| Conversation / Pins / 下载 | 两轮实际回答渲染到 Conversation；Pin 创建 HTTP 201；完整原生历史下载 HTTP 200、26 条记录 |
| 会话归属 | 三个修复后 Run 共用该合成 Session，没有切到普通 CLI/SDK，后续只发送新 Prompt |

该复测使用隔离 Work 和数据库；较早的失败记录未计为成功。现有用户 Work 和 Run 未重跑或删除。

**剩余边界：**基本网页 Run 复测时 SupportIQ 为 `needs-auth`，repository hooks 因工作目录未受信任而跳过；后续合成 Session 的原生连接验证见下方认证章节。没有代用户完成 TSE 授权、读取案件或通过 `--allow-all` 扩大权限来隐藏问题；telemetry extension 显示 running 也不证明接收端逐次送达。真实案件、其他就绪条件和 CaseIQ 安装维护者的出站合规要求仍需独立处理。

## 站内文档与维护

| 入口 | 用途 | 仓库原文 |
|---|---|---|
| `/docs` → CaseIQ Guides | 从 Quick Start 进入操作指南或技术协议；原有 Quick Start 的优先顺序保持不变 | Docs 首页只展示入口和范围说明，不重复维护完整状态 |
| `/docs/caseiq` | 安装、首次使用、恢复、故障排查、数据边界与当前验证结果 | [集成说明](caseiq-integration.md) |
| `/docs/caseiq/bridge` | 网页 Prompt 与旧 Terminal 共用的 bridge 请求/握手、离线验证及未验证边界 | [原生 bridge 协议](caseiq-native-bridge.md) |

站内两页沿用 WorkBoard 的访问控制，先认证、再读取固定白名单中的 Markdown；URL 不能指定任意磁盘文件。页面不额外探测安装或启动 CaseIQ。

原文目录可跳至对应标题，两份文档之间的相对链接在站内转换为相应路由并保留片段；仍可直接在仓库中阅读原文件。锚点为窄屏多行粘性导航预留空间，不把目标标题藏在顶栏后。站内只有一个页面主标题，保留代码块复制、当前文档导航和返回顶部。导航说明为中英双语，正文保留原始语言，不另存一份翻译后状态。

维护时修改本页或[原生协议](caseiq-native-bridge.md)，不要复制成另一份网页正文。调整标题/目录后运行下方文档回归，确认所有本地锚点有效；不要假定标题算法对任意文本都与 GitHub 完全相同。锚点按需启用，普通对话 Markdown 的默认呈现与安全 URL 规则保持不变。

本轮未引入新的 Markdown 依赖，也未绕过宿主包下载策略；标题 ID 由现有解析树生成，代码围栏里的伪标题不会变成导航目标。

## 当前支持范围

WorkBoard 在 **Runtime** 下拉框中提供 **CaseIQ**。新建 Work 可以直接选择它并点击 **Create & Run**；已有 Work 可以保存执行设置，或在 Prompt 面板选择本次 Runtime 后执行。不需要先 Create only 再找独立 CaseIQ 标签。

它调用原始 CaseIQ 启动器，再启动真正的 Copilot CLI；不通过 Copilot SDK 创建、恢复或控制 CaseIQ 会话。CaseIQ 的插件、支持包、权限规则和必要遥测仍由 CaseIQ 自己装配。

## SupportIQ 认证与临时终端

SupportIQ 认证独立于 WorkBoard 网站登录、GitHub Copilot 登录和 GitHub Packages 的 `read:packages` 授权。当前 CaseIQ 上游建议在其原生 Copilot 交互会话执行：

```text
/mcp auth SupportIQ
```

由用户在官方登录页面选择有权限的 **TSE 租户/账户**，而不是把 GitHub 登录当作 SupportIQ 授权。WorkBoard 不应收集密码、Token 或设备验证码，也不应借用当前聊天工具或其他 CaseIQ 实例的登录状态。

**必须使用该 Work 的原生环境。** WorkBoard 将 CaseIQ 状态隔离在自己的 `native/<session-id>` 下；认证应复用冻结的原生 Session、CaseIQ home、最终 Copilot home 与原启动器生成的 MCP 配置。直接启动默认 `caseiq` 或裸 `copilot --resume` 不保证使用同一缓存和配置。不要复制 OAuth 文件、清空 GitHub/Copilot 凭据或选“最新目录”来绕过绑定。

### 跨 Work / Session 共享登录（已接通）

**WorkBoard 现在接通 CaseIQ 原生 OAuth 共享方式，不再为每个 Work / Session 强制使用不同的 OAuth 缓存。** 新会话、同会话 Follow Up、恢复和专用登录窗口都经过同一个原生桥接点；只有 OAuth 状态共享，会话历史、Prompt、工作目录、映射、配置和工具批准继续隔离。这里只说明已接通的存储机制，不声称本机真实 TSE 双会话登录验收已经通过。

共享范围和接入方式：

- [原生 Session 准备逻辑](../src/lib/caseiq-integration.ts) 在宿主私有 runtime 根下创建稳定共享区，按 WorkBoard 用户、操作系统账号、主机和 CaseIQ 安装路径分组，不依赖单个 Work 或 SID 的生命周期，也不按每次源版本重新建组。
- [OAuth 桥接逻辑](../scripts/native-shared-oauth.mjs) 从原启动器实际生成的 MCP 配置识别 SupportIQ 端点和认证配置，再以摘要区分 profile。不同端点或认证配置不混用；工具列表、超时或描述变化不新建认证身份。共享位置为 `shared-oauth/<owner-scope-hash>/<profile-hash>/mcp-oauth-config`，不在网页暴露完整宿主路径。
- 每次原启动器装配完准确的原生 Session 后，在真正调用 CLI 前重新接好 `mcp-oauth-config` 链接。原启动器下次修复自己的链接不会使 Follow Up 退回私有缓存。只替换经过校验的会话链接，原有目标目录及其文件保持原地；不读取、复制、合并、迁移或删除令牌。只有正确的 owner/Work/home 和批准握手才可实际启动原生任务。
- 与 CaseIQ 原生机制一样，整个 MCP OAuth 目录共享，因此该 profile 中其他 CaseIQ MCP 的 OAuth 认证也在共享范围内，不只是 SupportIQ。一个 profile 使用用户在原生流程中选择的 TSE 身份；切换账号或租户会影响该 profile 的其他会话，不支持将它当成同时使用多个账号的隔离区。不同 WorkBoard 用户不共享。

**首次切换可能需要再登录一次。** 旧 Session 私有缓存不会导入新的共享区。用户在一个已接通的 Session 中完成官方 TSE 登录后，相同 profile 的后续原生会话使用同一缓存；不需要逐个复制授权。已有但空闲的 Session 在下次 Run / Follow Up / 手动登录准备时接入；已经运行中的进程不会被热改缓存、取消或重放。旧认证绿色回执不能用来证明新共享 profile 已登录，存储 profile 变化后会退回未验证。

共享失败时不伪装成成功，也不阻止继续使用：真实旧缓存目录、不可安全替换的外部链接、目录/ACL/链接创建失败或无法确认的 SupportIQ profile 都保留原会话缓存。网页登录面板和原始日志会给出原因及按 Session 登录的回退；若链接替换中断，先恢复原链接，不能恢复则明确停止本次原生启动，避免在不明缓存上执行。

共享有效凭据不等于永久免登录：令牌过期、撤销、MFA/条件访问、端点或 scopes 变化仍可能要求官方登录。共享缓存也不修复 CaseIQ 文档另行列出的登录后即时重连问题；已打开连接可能仍需重连。每个 Session 仍需自己的原生状态检查，不复制另一个 Session 的绿色回执；工具批准和案件服务端权限不因共享登录而扩大。

实现依据是 CaseIQ 的 `Connect-CaseIQSharedHomeState` 和 `docs/case-session-migration.md`，不是绕开原认证流程。[github/copilot-cli#2780](https://github.com/github/copilot-cli/issues/2780) 的关闭说明称共享 MCP token cache 问题在 `v1.0.91` 或更新稳定版看起来已解决，但这不代替本机真实验收。离线测试使用合成 marker 和原生桥接 fixtures 验证跨 Work、冷启动、Resume、不同 owner/profile 隔离、并发准备和失败恢复，不使用客户案件或真实令牌。真实验收仍需 A 由用户完成一次官方登录，B 冷启动且不再次登录，独立检查原生连接和只读 OAuth 证据；这些检查也不能代替案件权限验证。

### 网页手动登录入口

1. 在 **CaseIQ Runtime** 的 Work Conversation 顶部展开默认折叠的 **SupportIQ sign-in** banner，点击 **Sign in to SupportIQ**。等待当前 Run 和已排队消息结束后，按钮才允许打开认证窗口。**Trust this Work's exact folder** 现在默认勾选，只作用于当前 Work 的准确目录及私有 Session；用户可取消，同一页面中该 Work 的明确选择不会因 Follow Up 换 Run 而被重置。
2. 也可在 Follow Up 输入确切的 `/mcp auth SupportIQ`。WorkBoard 将它当作本地认证动作，而不是用户 Prompt；不创建 Follow Up Run、不中转给模型。包含其他文字的自然语言请求仍是普通 Prompt，不能代替此入口；认证命令不能附带文件。
3. 点击登录按钮时，WorkBoard 先将固定的 `/mcp auth SupportIQ` 复制到剪贴板，成功时显示 **Command copied**；另有 **Copy authentication command** 手动复制按钮。浏览器拒绝复制时显示错误和手动输入回退，不伪装成复制成功，也不因此禁止打开认证窗口。将命令粘贴到原生窗口执行，在官方页面选择 TSE 账户；WorkBoard 不代填凭据或批准原生提示。
4. 打开的窗口调用原 CaseIQ 启动器，恢复当前 Work 的准确原生 Session。WorkBoard 自有观察扩展只附加该 Session，查询真实 MCP 状态、live `tools/list` 并再次核对仍为 `connected`，同时执行运行时只读 `mcp.oauth.probe` 观察 OAuth 令牌；不能仅凭可列工具断言登录有效；不创建 SDK Run、不发送模型 Prompt、不调用案件工具或读取 Token。
5. 页面每 5 秒及返回焦点时自动读取原生检测结果，不再要求必须手动 Refresh；**Refresh sign-in state** 仍可手动重查，显示检查进度和完成时间。取得当前操作、Session、nonce、已接受 binding 和实际 native-spawn 均匹配的正向回执后，banner 摘要显示 **OAuth checked** 和工具数。新认证流程只自动展开一次；同一流程的轮询不抢占用户折叠状态。没有回执、接口失败、`needs-auth` 或连接变化时明确显示未验证或 **Needs attention**，不用窗口退出或日志代替连接证据。
6. 目前仍需用户正常退出 Copilot，再等待包装进程退出。若直接关闭窗口导致收尾回执缺失，WorkBoard 会核对准确包装器创建身份、关联接受/journal 和记录的原生 PID；只有确认两者已停止，才解除占用。仍存活或无法核对时继续提示未确认。仅回收当前操作自己的观察扩展，不删除 OAuth 缓存或其他扩展。
7. 窗口关闭后的绿色状态表示该 Session 的**最后一次原生连接验证**，不是声称已经关闭的 CLI 仍有活动 MCP 连接，也不证明全部案件权限。由用户决定是否发送新的 Prompt；此前的 Prompt 不自动重放。

原 CLI 的 **Confirm folder trust** 是对当前 Work 目录中配置、代码和 hooks 的信任确认，不是 SupportIQ OAuth，也不是 Full access。上述默认勾选的选项授权 WorkBoard 在原生启动前向**绑定 home 的私有 `config.json.trustedFolders`**追加准确 realpath 目录，保留其他键并去重。它不信任父目录、不改全局配置，不增加工具权限；该选择冻结在幂等认证请求中。当前 CLI 使用 camelCase `trustedFolders`，不能用上游旧 `trusted_folders`、`settings.json` 或不适用于交互 Resume 的 `--trust-folder` 替代。用户取消后仍由用户处理原生提示。已经显示 `process exited` 的旧测试窗口不要按 Enter 重启，应关闭后从当前 Work 的登录按钮重新打开。

独立认证接口为 `GET/POST /api/works/<work-id>/caseiq/auth`。它校验网站用户、Work/Run 关联、拥有的 Windows 主机、安装路径/Session/home、当前任务占用、同源 JSON 请求和幂等请求 ID；POST 接受 Run、请求 ID、明确的 `trustWorkFolder` 布尔选项及 `automatic` 标记。旧客户端省略目录信任选项时，服务端仍按 false 处理；网页默认勾选后明确发送 true。自动请求还必须对应服务端实际观察到、尚未处理的原生认证需求，不能仅凭客户端标记打开窗口。状态和控制记录保存在宿主私有目录，不创建普通 Run、不转 SDK 执行、不改 Work 权限模式。

### 自动开窗与流程指引

需要用户操作时，Portal 在 **Follow Up 输入框上方**保留高亮的 SupportIQ 引导，不要求用户向上寻找或展开顶部 banner。它复用同一真实状态：准备中先等待；原生 Session 启动后突出显示 `/mcp auth SupportIQ`、选择 TSE 账号以及检查完成后退出 Copilot 的步骤；OAuth 已检查但窗口未关闭时高亮“关闭 Terminal / 释放 Work”。复制命令、刷新和可用时的手动登录按钮复用原有动作及准确目录信任选项，不提交 Follow Up、不清空草稿。顶部展开后的 Next 动作也使用主题感知的高对比提示；未知空闲状态和完成释放后的会话不留下永久高亮卡片。

原生认证窗口使用黑字黄底标题/禁止任务提示，以及黑字青底命令块，明确列出“等待原生 Prompt → 执行命令 → 选择 TSE → 检查后退出并返回”。提示在准备开始和实际调用 CLI 前各显示一次，避免被长启动日志冲走。仅认证窗口显示，不给普通 Run 或普通 Terminal 加认证说明；不会自动执行显示的命令。已经打开的旧窗口不会被重写，新样式在下次开窗时生效。

当前可见的 **Work Detail → Conversation** 收到该 Run 的明确 SupportIQ 原生认证需求时，会自动执行现有按钮动作：复制固定命令、准备准确的原生 Session、按复选框选择预信任准确 Work 目录并打开 Windows Terminal。可用信号来自原生 MCP OAuth 请求、`needs-auth` 状态或明确的 SupportIQ 工具认证失败，不使用助手自然语言、普通未知状态或旧绿色标记触发。后台标签页、其他侧栏面板、远程主机与归档 Work 不自动开窗；手动按钮始终作为可用时的回退。

Run 或队列仍在执行时先显示等待，空闲后再开窗，不自动取消任务或抢占原 Session。自动请求 ID 由所属用户、Work、Session、Run 及实际信号确定，多标签页并发受同一 Work/Session 启动锁和幂等记录保护。同一需求已经打开过窗口后，不因刷新、关窗、失败或认证窗口自身产生 OAuth 请求而循环重开；认证窗口事件不在原网页 Run 的执行时间范围内。用户可手动重试，或由后续 Run 的新原生认证需求触发下一次自动流程。失败的 Prompt、工具调用和队列消息不会自动重放。

banner 中的动画与步骤区显示 **Request accepted → Original Session prepared → Native Session started → TSE sign-in and OAuth checked → Terminal closed / Work released**，同时明确当前动作和 **Next**。包装器存在不等于原生 Session 已启动：只有准确匹配接受回执的 `native-spawn` 才推进该步骤；目录信任也只在相应原生启动证据后标为完成。OAuth 步骤仍要求真实连接、非空工具列表及关联的只读 OAuth 探测。未确认、失败和仅关闭窗口都不会显示全部完成；动画遵循 reduced-motion，不提供虚假百分比。

自动化只完成现有开窗按钮的动作，**不会自动粘贴或执行 `/mcp auth SupportIQ`、替用户完成 TSE 登录或强制关窗**。浏览器可能拒绝无手势的自动剪贴板写入，此时仍打开原窗口，并明确指导用户手动输入固定命令。用户在官方页面选择 TSE 账户，等待网页显示 OAuth 检查结果后正常退出 Copilot；页面自动确认停止、释放占用，并提示发送用户决定的新 Follow Up。读取进度只做归属路径和原生回执检查，不在每次轮询重新执行 Git/CLI 能力探测；真正准备原生操作时仍检查当前运行能力。

同 Work/Session 的 Execute、Follow Up 和比较等启动操作在认证期间被持久占用保护阻止；Follow Up 草稿保持可编辑，只限制发送。正常收尾需完整关联回执；缺失回执的认证窗口可凭准确包装器创建身份、已接受的同 Session journal 和已不存在的记录原生 PID 恢复停止状态。没有进程停止证据时仍保留占用；退出码、缓存更新或用户说“登录完成”均不会被标成已验证的 MCP 权限。

本轮原生浏览器认证路径验证修复了 WorkBoard 包装器的错误异常类型引用：使用实际存在的 `Microsoft.PowerShell.Commands.WriteErrorException` 与 `System.Management.Automation.MethodInvocationException`，避免原生会话启动前因非关键错误记录而抛 `TypeNotFound`。新增回归覆盖此边界，以及明确未调用原生会话的关联失败证据；缺少这些证据时仍保留未确认占用。真实浏览器验证观察到正确 Session 的原生 PID/包装器 FILETIME，且没有发送 Prompt、创建 Follow Up Run 或调用客户工具；测试取消是清理，不是认证成功。

测试门户可使用独立生成目录（例如 `.next-test-caseiq`），通过相同的 `WORKBOARD_NEXT_DIST_DIR` 值构建和启动，不覆盖或重启使用默认 `.next` 的实例。私有数据库和 CaseIQ 状态不放在构建目录中，trace 守卫和后台启动检查均使用所选输出；不指定此变量时仍使用默认 `.next`。

### 自动化方案与实际阻碍

当前交付支持上述受明确原生信号约束的自动开窗及手动回退，不自动粘贴或执行 slash 命令。原生 MCP 确认连接、实际 `tools/list` 成功且同一次原生调用的 OAuth 探测报告附带令牌后，网页才显示 **OAuth checked**；这仍不保证案件访问权或下一次 Run 一定成功。自动成功关窗仍未交付；失败时保留明确的手动重试，不循环弹窗、不提升 Full access，也不自动重放旧 Prompt。

实测 CLI **1.0.107** 不支持独立的 `copilot mcp auth` 子命令；`/mcp auth` 是交互命令，不能简单当网页 `-p` Prompt 发送。此前空闲、新会话和准确 Session Resume 的观察探测没有得到就绪回执，不能据接口文档宣称链路可用。后续改为在已接受的原生启动边界，向准确私有 home 临时装配自有观察扩展；当前已在真实原生 Session 取得连接和工具回执。不能断言目录预信任就是所有早期失败的唯一原因。

用户此前在准确绑定的合成 Work 原生窗口完成登录；该次用户说明和原 CLI 日志本身不作为验证证据。本轮通过真正的网页按钮打开一次无 Prompt 的认证 Resume，实际验证私有配置只追加准确 Work 目录、剪贴板成功提示以及原生 `connected`／10 个 live 工具的关联回执。浏览器 Refresh 显示绿色验证状态；另复现并修复了此前展开的选项在验证成功后没有自动收起的问题。测试未新建普通 Run：独立数据库仍为 4 个 Work、9 个 Run、活动 Run 为 0；没有执行模型 Prompt 或客户工具，CaseIQ 源码未改。

测试结束通过当前操作的关联控制记录停止所属原生进程，确认占用解除、自有观察目录移除、最后验证回执保留。这是**测试清理，不是产品自动成功关窗**。正常退出由 delegate 清理；直接关闭窗口时，只有完整归属和停止证据匹配，才清理准确自有目录。错误上下文、存活 PID 或意外文件均不删除。

最终发布复测中，新打开的同一合成 Session 先返回 `needs-auth`；已核对 Session、home、MCP 配置和冻结版本都没有切换，未推测重新认证的原因，也未清理凭据。用户本人完成登录并关闭终端后，网页实际返回 `authenticationVerified=true`、`connected`、10 个工具、`closed`／`reserved=false`；Refresh 显示最后验证时间，完整黄色登录提示自动收起。Follow Up 草稿可输入，输入后发送按钮重新可用；测试未发送消息并清空自己的临时草稿。另一次集成浏览器因未聚焦拒绝剪贴板写入，页面明确显示手动输入回退，认证请求仍正常被接受。

### 当前明确回退

原生观察不可用时，回退仍是上述网页手动登录入口：由用户在同一原生环境完成命令并正常退出认证窗口；正常任务仍回到 WorkBoard 的 CaseIQ 网页 Runtime，用用户决定的新 Prompt / Follow Up 执行，不把全部任务转到 Terminal。未验证的已关闭操作收为明确的 **SupportIQ connection unverified** 状态，不保留完整黄色登录 banner，也不假装绿色成功；后续原生 Run 仍重新检查 MCP。

终端退出、日志中的“认证完成”、缓存更新时间和普通模型回答成功，均不能单独成为网页“已授权”的判据。只有关联的结构化原生连接和工具证据才显示验证；自动关闭认证窗口仍未实现，不应作为已交付能力宣传。

### 登录成功但工具调用被拒绝

**登录、工具执行批准和资源访问权是三件不同的事。** 绿色 `SupportIQ sign-in verified` 只证明原生会话曾连接并取得工具列表，不自动授予模型调用工具的权限，更不替代服务端的案件访问控制。其他 MCP 同样可能需要工具执行批准；本节的网页能力现已按 MCP 分组，不再仅限 SupportIQ。本轮只扩展工具批准，其他 MCP 的账号登录流程没有新增或自动代办。

实际失败回执曾明确为 `denied-no-approval-rule-and-could-not-request-from-user`：对应的网页 Run 只有原启动器声明的两个 Scope 工具和两个上报工具，未批准 `SupportIQ(case_get)`；网页 `-p` 运行又没有原生交互审批窗口，因此在本地执行批准阶段就被拒绝。重复登录不能补齐这个 allow rule。普通 CLI 的 Standard tools 使用 `--allow-all-tools`，CaseIQ 不直接继承这一宽泛授权，也不通过 Full access 隐藏问题。

1. 在该 Work 的 Conversation 顶部展开默认折叠的 **MCP tool approvals** banner，或打开导航中的 **MCP** 配置页。配置页左侧选择 Work/Session，右侧管理其对应服务，例如 `SupportIQ` 或已发现的 `safewright`；必要时点击 **Refresh tool approvals**。
2. 新配置从 **Settings → CaseIQ MCP defaults** 初始化，自动授权初始默认勾选；用户可在 Settings 配置各 MCP 的自动/手动初始模式。**已有保存的 Work/Session 配置保留，不因默认值变化而自动开启。** 每个 Work/Session 仍可单独选择：
   - **Allow this tool**：只批准该服务的准确工具，例如 `SupportIQ(case_get)` 或 `safewright(browser_snapshot)`；不同 MCP 的同名工具不会互相授权。
   - **Allow all requested tools (N)**：一次批准当前 MCP 分组中显示的待批准工具。请求冻结用户看到的准确名称集合，不会批准另一个 MCP 或稍后才出现的新工具；组织托管的工具不纳入此批次。
   - **Automatically allow all &lt;MCP&gt; tools in this Work/session, including future tools**：用户显式勾选后，仅对选中的 MCP 开启服务级自动批准。它涵盖该服务当前及后续新增工具，**也包括将来可能提供的写入型工具**，不是“只读工具包”或全局 MCP 开关；不希望扩大到后续工具时使用前两种手动方式。
3. 该批准只记在当前网站用户、Work、原生 Session 和宿主的私有状态中。其他 Work、其他 Session、其他 MCP、文件/URL 权限均不继承；组织托管的批准仍不能被本地规则替代。一个 MCP 开启自动模式不会改变其余 MCP 的已有逐项或自动设置。
4. 发送一条新的 Follow Up 或明确执行新的 Run。失败的 Prompt 和已结束的工具调用不会自动重放。手动模式下，新出现的未授权工具仍需逐项或再次批量批准。
5. 取消自动授权复选框会恢复逐项模式，**原来明确批准的单项规则仍保留**；若也不再允许某个原有工具，再点击其 **Revoke tool approval**。自动模式下不显示会产生误解的逐项撤销按钮。运行/排队/认证占用期间不修改规则；每个原生 Prompt attempt 冻结准确授权集和自动模式，并在启动接受边界再次核对。

MCP 配置入口位于 **Work Detail 左侧面板 → MCP configuration**，不在顶栏全局导航中。该面板只显示当前 Work 在本执行主机的 CaseIQ 网页 Session，可在当前 Work 内切换 Session，不共享它们的覆盖项。跨 Work 的初始默认值只在 Settings 中配置：从已有会话的原生权限请求和已保存配置汇总已发现 MCP，不接受手填服务器、任意 URL 或命令。新 CaseIQ 会话首次初始化时复制当时的默认值和已发现服务列表；后续 Settings 修改不重写该快照。新服务若在当前 Run 启动后才首次被发现，其批准只能在下一次明确启动的 Run/Follow Up 生效，不会热提升当前 Run 或重放失败调用。

原有 SupportIQ 入口保留兼容。原启动器已允许的 Scope Assist 和完成上报工具不必重复批准，也不会被 WorkBoard 的手动模式撤销；组织托管、服务端认证或 MCP 自身安全策略不被这个面板绕过。

**SupportIQ sign-in** 和 **MCP tool approvals** 收纳在 Conversation 顶部的两个默认折叠 banner 中，摘要保留状态、待批准数、自动模式数或错误提示；点击摘要才展开，后台刷新不会抢占展开状态。折叠入口采用与工具栏一致的透明、按内容宽度布局，单项高度 28px；不再使用两个铺满整行的白色卡片，窄屏自然换行。标题、状态和错误提示使用现有亮/暗主题色，较长摘要截断时保留完整悬停文本与无障碍内容；只有展开后的详细内容使用主题背景。操作按钮继续使用透明轻量样式。Work Detail 左侧的 **MCP configuration** 直接展开配置内容，Session 选择框只列出当前 Work 的会话。banner 内的配置按钮在本页切换面板，不离开 Work、不丢弃 Follow Up 草稿。旧 `/mcp` 链接保留兼容跳转：带 Work/Session 的链接转到准确的 Work 面板，仅带旧 Run ID 时先核对所属用户并解析原 Session；不把旧 Run 替换成当前最新会话。没有上下文的旧链接转到 Work 列表。

服务分组仍可独立展开/收起；首次读取显示加载状态。手动刷新显示检查进度、完成日期和时间，重复点击不会重复发起检查。旧轮询结果不会覆盖随后保存的授权或新打开的认证窗口。保存结果不确定时保留错误、暂停再次授权，用户明确刷新并核对后才能继续；后台轮询不会把该警告悄悄清掉。按钮的无障碍名称同时包含 MCP 和工具名，长名称在窄屏换行。认证的最后验证时间仍在展开内容中显示完整日期，避免把昨天的连接记录当作今天的实时状态。

手动批准通过原启动器的正常装配链路追加精确 `--allow-tool MCP(tool)` 规则；显式自动模式仅追加选中服务的 `--allow-tool MCP`。原有平台规则和原生拒绝规则保留，有效参数计入 `prepared` 的 allow list 和参数 hash。没有 `--allow-all-tools`、`--allow-all-paths`、`--allow-all-urls` 或 SDK Run 转换。共享校验拒绝通配符、选择器注入和 `shell`／`read`／`write`／`url`／`memory`／`custom-tool` 等会与内建权限类别冲突的 MCP 名称；不能安全表达的标识符明确报错，不降级成更宽规则。

通用接口为 `GET/POST /api/works/<work-id>/caseiq/mcp-permissions`，沿用网站用户、拥有的 Work/Run/Session、同源 JSON、所属 Windows 主机和启动占用校验；提交的服务必须来自真实会话记录、保存的批准或该 Work 已初始化的默认快照。旧 `caseiq/tool-permissions` 接口继续只投影和修改 SupportIQ，不覆盖其他 MCP 设置。MCP 页面通过只读 `GET /api/caseiq/mcp-sessions` 汇总拥有的会话；Settings 使用 `GET/PUT /api/caseiq/mcp-defaults` 保存本用户/主机的初始默认，写入同样要求本机、同源 JSON。

私有 v3 配置分别保存默认快照和 Work/Session 覆盖项。旧 v1/v2 读取不改写，并保留原手动基线、单项批准和自动选项；首次显式保存时才升级为 v3。即使 Work 的快照默认自动，用户取消某个 MCP 的自动选项后，空的手动覆盖也会持久保存，不能因缺少单项规则而重新继承自动模式。读取配置或改变 Settings 不重放任务；认证和旧 Terminal 启动不会继承网页策略。

配置页与 banner 改版验证了 Settings 的初始自动勾选、未配置会话的继承，以及手动关闭在真实 API 保存/刷新后仍有效而不改变 Settings。已有用户配置保持原模式和文件字节不变。Conversation 两个 banner 首次加载均折叠，轮询不强制展开；操作按钮为透明主题样式。亮/暗主题的 390／738／1024／1280 像素布局均通过检查，未执行客户案件查询或重放任务。

发布检查还复现了旧认证窗口的 PID 被无关进程复用后，占用提示重新出现的问题。缺少收尾回执时，除原生 PID 已不存在的证据外，可核对现存进程的创建时间明确晚于该次记录的 native-spawn，证明它已不是原来的原生进程。停止确认与原始请求、nonce、Session、接受 hash 和包装器创建身份绑定并持久记录；已确认停止的操作不因后来 PID 复用而重新占用。无法验证时仍保留占用，不结束那个无关进程。

后续状态检查仍逐次校验这份持久停止证据与原始接受/journal 的关联，但不再为已经证明停止的操作反复启动 PowerShell 查询 PID。它不缓存 MCP 授权或放松下一次原生启动检查；无证据的运行窗口仍核对实际进程。

同一认证操作的并发状态读取只合并仍在进行中的完整检查，避免两个读取者在 Windows 上同时提交 `authentication-stopped.json` 而触发 rename `EPERM`。检查结束后释放共享 Promise，后续请求仍重新验证证据；不以重试覆盖或忽略写入错误来伪装成功。

本轮可用性复测通过 11 个测试文件、160 项目标回归，以及类型检查、目标 lint 和隔离生产构建。真实网页确认带日期的历史认证状态、刷新完成反馈和 Follow Up 草稿可用；受控合成响应复现并验证了旧读覆盖保存、保存失败后的显式恢复、重复刷新合并，以及 390／738／1280 像素下长工具名不溢出。所有模拟仅限合成 Work，结束后恢复真实接口；未提交任务、重放客户查询或替用户扩大授权。

已使用相同原生 CLI 的独立本地 stdio 合成 MCP 验证精确规则：仅 `case_get` 被执行，未批准的合成工具产生上述拒绝回执且没有进入 MCP 工具实现；结构化配置证明该测试进程只有本地合成 SupportIQ。此验证没有访问真实 SupportIQ 或客户案件，不等于业务案件已读取成功。授权后若仍出现服务端 401/403、案件 entitlement 或其他错误，应分别核对 SSO 与服务端访问权，不扩大本地权限来绕过它们。

统一授权另外在两个明确的本地合成 MCP 上复测：自动模式可运行 SupportIQ 的两个工具，同服务的显式拒绝规则仍有效，另一个 MCP 的工具仍因未批准而拒绝。随后在**同一个真实原生 Session Resume** 中关闭自动模式，仅保留准确 `case_get` 规则；该工具继续成功，先前自动允许的另一个工具重新被拒绝。验证依据为实际工具实现调用记录和结构化原生事件，未查询客户案件，也未启用真实用户 Work 的自动授权。

发布期间还确认了 CLI 的另一层版本选择：同一个原生可执行路径默认可转到已下载的较新版本，路径不变并不保证运行版本不变。WorkBoard 的只读版本/help 探测、启动器中的版本拦截和实际 CaseIQ 原生调用一致使用官方 `--no-auto-update`，确保同一次启动观察与实际调用一致。此参数不再用于跨 Run 锁定旧版本：可执行文件更新后，下次 Run 记录实际新版本并继续使用原 Session，只要求仍具有必要的调用能力，不降级全局安装或清空缓存。

新版网页在合成 Work 上实际验证了自动选项开启、刷新页面后保留、关闭后持久恢复手动模式；没有发送任务或查询客户案件。批量界面验证其 POST 只包含当前可批准的准确工具快照，真实 API 对从未请求的工具返回 400；既有真实用户 Work 的授权文件字节保持不变，默认自动选项仍关闭。

多 MCP 扩展在冻结的真实 CLI 1.0.107 上用三个本地 stdio 合成 MCP 验证：SupportIQ 仅允许一个准确工具，另一个 MCP 单独自动批准，未选中的第三个 MCP 仍拒绝，显式 deny 规则仍生效。同一原生 Session Resume 关闭第二个 MCP 的自动模式后，其原有准确工具继续可用、额外工具重新拒绝，SupportIQ 不受影响。检查同时使用结构化原生事件与实际本地工具实现记录，未连接真实 SafeWright、其他企业 MCP 或客户案件。

新版分组界面另外验证了：批量只发送选中 MCP 的待批准快照，已有/托管工具不被纳入，切换其自动模式不改其他组；真实通用 API 保存的 v2 状态在刷新后保留，旧 SupportIQ API 仍返回一致的原格式投影。实际 API 拒绝未观察到的 MCP 和内建权限类别。服务名及工具名达到允许的 128 字符上限时，在 390／738／1280 像素宽度下含长状态提示也不溢出。所有真实保存仅作用于合成 Work，测试后恢复原状态；已有用户授权文件未重写。

## 网页 Runtime 能力

**网页 Run 与旧 Terminal Run 是不同执行方式。** 新网页 Run 保存 `engine=CASEIQ`、`providerId=caseiq`；旧 Terminal Run 仍是 `engine=CLI`、`providerId=caseiq`，不会被误当成普通 CLI 或静默转换为网页会话。

| 能力 | 状态与操作 |
|---|---|
| Web Execute | 原始启动器准备好后，使用真正的原生 CLI `-p` 执行用户 Prompt；不创建可见终端窗口 |
| 支持包与平台能力 | 默认沿用原始 CaseIQ 的共享 platform、runtime、telemetry 装配；不为普通 CLI 伪造 CaseIQ Agent |
| 初始 Prompt | 点击 Create & Run / Execute 即按用户意图发送已保存 Prompt，包含原始换行与 Unicode，不套用固定示例 Prompt |
| 问答、审批、认证 | 不伪造批准或输入；MCP 工具批准按服务提供逐项、当前请求批量及显式自动模式，SupportIQ 登录仍是独立入口；仅后续明确启动的 Run 生效，其他 MCP 登录流程本轮未扩展 |
| 会话绑定 | 从真实 CLI 启动点读取实际 home/session，不解析 TUI 或猜测最新目录 |
| 会话历史、Pins、结果 | 使用绑定的同一原生历史，沿用 WorkBoard 的读取和同步机制 |
| Follow Up / Queue | 使用相同 CaseIQ session/home、冻结安装及父 Run 配置；只发送新的消息，不重发初始 Prompt |
| 模型与权限 | Auto 使用 CaseIQ 默认模型，也可显式选择模型与同 Provider fallback；保留 CaseIQ 权限，不继承 CLI 的 Full access |
| 附件 | 使用与 CLI 一样的已授权文件路径传输；自动续跑不重复附加本轮文件 |
| 输出 | 内部使用 JSON 事件流，网页仍显示正常 Conversation、结果与日志 |
| Web Cancel / Timeout | 取消所属隐藏包装进程与原生子进程；准备阶段也受截止时间保护，未确认停止时不释放 Work |
| Steering | 与普通非交互 CLI 一致，不挂载 SDK 专属实时控制面板 |
| Skill comparison | 选择 CaseIQ 时仍经同一 CaseIQ 执行器，变体工作区不修改 CaseIQ 源码 |
| 旧 Terminal | 仅旧会话保留兼容入口；不能网页 Follow Up，也不作为网页失败后的自动回退 |
| 非 Windows、跨宿主 | 明确阻断不兼容执行或恢复，不在浏览器所在机器偷开程序 |

普通 Copilot CLI / SDK 的设置、执行和对话行为保持独立。仅在 Runtime 中选择 CaseIQ 才进入 CaseIQ 启动链路；在普通 CLI 的 Agent 文本框填写 `caseiq` 不等价于此集成。
Work Detail 状态栏按当前实际 Run 的 provider 显示与应用森林绿主题协调的固定深青绿色 **CaseIQ** 标签，与 SUCCESS／RUNNING 等运行状态分开；旧 CaseIQ Native Terminal Run 也保留明确标识。Work 默认 Runtime 改动不会反向改变已经启动的 Run 标签。Run 详情、运行列表、Work 内历史及 Work 卡片上的 CaseIQ 标签复用同一全局配色，亮暗主题不改变其身份色；Work 卡片标签的悬停说明明确表示默认 Runtime，而非实际 Run。仅在 Runtime 中选择 CaseIQ 才进入 CaseIQ 启动链路；在普通 CLI 的 Agent 文本框填写 `caseiq` 不等价于此集成。

## 同一 Work 双 Session

在本机 Windows 的 **New Work** 输入一份 Prompt、选择目录并添加所需附件，然后点击 **Create & Run Both**。普通 **Create & Run** 仍只启动选定的 Runtime。未运行过且没有 Automation 的 Work 也可在 **Prompt → Run Both Sessions** 启动配对；已有 Session 的 Work 不自动转换或重放。

- **Conversation → Both**：宽屏并排显示两份独立历史。拖动中间分隔线可给一侧更多空间，刷新保留比例；双击或在分隔线上按 **Enter** 恢复等宽，方向键也可以调整。空间不足时上下排列，用 **Jump to** 跳到任一侧，不改变双发目标。手机窄屏可以滚动页面到下方输入框，不会为固定输入框而压缩对话区。**Send to both Sessions** 发送同一条 Follow Up 和同一份附件。
- **Copilot CLI / CaseIQ**：只聚焦该 Session，刷新仍保留所选视图。Follow Up 上方会标出目标和每侧的 **Ready / Will queue / Unavailable**；如果双发不可用，会说明哪一侧有阻碍。切换 Tab 不清空当前草稿；提交或确认结果前，发送目标保持锁定。
- **Follow Up 回执**：确认提交后，输入框下方分别显示每侧是 **Accepted** 还是 **Added to queue**。点击对应项会在新标签页打开准确的 Run，不离开当前草稿。回执记录的是提交结果，不代表 Run 已经完成；它保留在当前页面，直到有新的确认回执或手动关闭。
- **阅读旧消息时不跳页**：提交和新消息不会把正在读历史的一侧拉到底部。若有新消息，该侧标题栏的向下箭头会亮起提示，点击才跳到最新消息；另一侧的滚动位置不受影响。
- **每侧独立操作**：标题栏显示各自的 Run 状态，并可切换原始输出、跳到最新消息或下载历史；底部点击 Queue、Pins 或 Session usage 可展开明细。SupportIQ 登录只打开该 Work 的原 CaseIQ Session，不发送任务。
- **直接找生成文件**：点击任一 Session 标题栏的文件夹图标，**Work files** 会直接打开它的输出目录。宽屏保留对话在旁边；窄屏切到 **Files**，点标题旁的返回箭头可回到对话。在文件面板也可以用 **Shared / Copilot CLI / CaseIQ** 切换位置。浏览文件不改变草稿或 Follow Up 发送目标；可在新标签页预览文件，或仅将路径插入当前草稿。Run 写入新文件后可点 **Refresh files** 更新列表。
- **目录**：原 Work 目录作为共同输入，保留初始 Prompt 和附件。两侧分别在 `work-results-<CLI Session ID>\copilot-cli` 和 `work-results-<CLI Session ID>\caseiq` 执行；相对路径生成的文件、Run 产物和差异快照分别保存在对应目录。WorkBoard 指示两侧只读共享输入、只向各自目录写入；这不是 Windows 文件系统沙箱。后续消息留在两侧的 Run 与 Conversation，不重复追加到共享 Prompt 文件。

**排队与回退：** 双发必须先验证两个准确的 Session 和各自队尾，然后一次保存。任一目标无法接收时不会只发给另一侧；可以修复后重试，或切到可用一侧刻意单发。提交后两侧独立执行：空闲侧可以立即启动，忙侧按自己的队列顺序运行，实际并发受 WorkBoard 并发上限约束。一侧运行失败不取消另一侧，也不会自动回放失败请求或换用另一 Session。若启动前 CaseIQ 不可用，没有创建配对的 Work 可在修复后重试，或改为普通单 Runtime；若一侧从未成功建立历史，保留原结果并新建 Work 重试，不会在原配对中偷偷换 Session。

发布需先应用新增配对表的 SQLite 迁移；旧 Work 无配对记录，原行为不变。CaseIQ 源码、原生启动器和已有认证存储不需要修改。

## 网页运行流程

1. 在 Work 表单中选择工作目录，填写自己的 Prompt。
2. 在 Runtime 中选择 **CaseIQ**；保持默认 Agent，或显式使用受该 CaseIQ 安装支持的 Agent/模型。
3. 点击 **Create & Run**。已有 Work 则在执行设置中保存 CaseIQ，或在 Prompt 面板选 CaseIQ 后点击 **Run Work**。
4. 在正常 Run / Work 的 Conversation 和输出中查看准备日志、回答、结果和附件；不会打开 Windows Terminal。
5. 任务结束后直接发送 **Follow Up**；运行中可使用普通消息队列。后续消息仍使用原 CaseIQ 会话，不能切成普通 CLI/SDK。
6. 用现有 **Cancel / Stop** 取消网页 Run；超时也是同一取消路径。如果停止未确认，Work 继续保留占用并明确提示检查，不冒险重复启动。

准备阶段可能检查/安装原启动器管理的依赖，或因企业认证、私有包、MCP/工具权限而失败。WorkBoard 不收集凭据、不替用户登录，也不自动回答审批。错误保留在网页 Run 中；不要把“启动器已准备”或退出码 0 当作任务与遥测全部成功。

### Conversation 无输出时

Conversation 原本只读原生会话历史；如果 CaseIQ 还在准备依赖/认证、尚未通过 `prepared/accept` 启动 Prompt 进程，就没有原生消息可显示。这与“已有模型回复却丢失”不同，也不能只凭 RUNNING 徽标认定模型已经开始执行。

默认 Conversation 现在会在没有会话消息时显示明确标记的 **Run startup and output**，使用现有 Run 日志和实时输出流。它展示实际启动/认证/错误信息，不伪造聊天消息；真正的历史消息出现后自动接管。尚未创建的 Work/Run 和查看已固定 Pins 时不会显示无关 Run 的输出。

活跃的 CaseIQ 网页 Run 会在 **Conversation 时间线当前执行位置**显示启动状态，跟在本次请求与已记录活动之后，而不再固定在全部旧历史上方。因此同 Session 的 Follow Up 即使已有历史消息，也能在最新请求处看到该 Run 的初始化动画、当前启动尝试的等待时长和已报告阶段。它只是绑定准确 Run 的临时状态，不写入原生聊天历史；查看已固定的 Pins 历史片段时不插入当前 Run 的提示。用户停留在最新消息时，阶段更新导致提示高度变化会继续跟随到底部；用户向上阅读旧消息时不会被强制拉回。阶段来自 WorkBoard 协调器的真实执行点：检查冻结安装与 PowerShell、准备私有 Session/MCP 配置、调用原启动器、接收准备握手、核对关联的 `native-spawn`，以及当前原生输出中的 assistant/tool 活动。包装器 PID、旧会话消息和普通启动器输出均不能证明模型已开始工作；native 已启动也不表示所有 MCP 均已就绪或登录成功。

当前启动尝试的真实工具调用一旦出现在上方时间线，下面通用的 CaseIQ 初始化/“正在工作”动画就会隐藏，由 **Tools & run details** 接管执行反馈。只有工具角色事件且时间不早于当前启动尝试才算证据；旧会话工具、助手文字或缺失时间不会让新 Follow Up 提前隐藏初始化。内部 fallback/continuation 开始新的启动尝试时重新按其起始时间判断；取消中的停止提示和观测错误仍明确显示。Raw output 保留独立状态，不因 Conversation 已显示工具而丢失诊断入口。

Conversation 左下角的 **Session usage** 按名称列出当前 Session 中已记录的 MCP 调用次数和 Skill 执行次数；窄屏可在 Follow Up 上方展开。它统计保留的完整会话历史，包括同 Session 的历史 Run / Follow Up 和未加载到页面的记录。MCP 按服务器汇总，主数字是发起总次数，不是成功次数；括号内红色数字是有匹配失败回执的调用数，同一次调用只计一次，缺少结果不标失败。Skill 只统计实际调用事件，不推断执行结果。配置、权限请求和 Prompt 中提到的名称不计入。

**View startup logs** 切换到当前 Run 的实际 Raw output，不向聊天历史插入伪造消息，也不展开顶部登录/授权 banner。状态不提供虚假百分比或预计完成时间；同一 Run 的原有 fallback/continuation 会重置启动尝试，而不会新增自动重放。取消显示停止中，结束后不再显示动画。状态 API 只返回所属 Run 的阶段元数据；刷新可重新读取当前协调器的快照。服务重启、主机身份不匹配或状态检查失败时明确标注不可观测，并保留日志入口，不猜测 Prompt 尚未发送。

本轮只读诊断到一个具体失败：原启动器要求 GitHub `read:packages` 包权限，在浏览器授权/npm 认证准备处等待；没有原生绑定 home、没有接收握手或 native journal，随后触发两分钟准备超时并标记 FAILED。这个 Run 没有可恢复的模型 Session。先按获准的宿主浏览器认证流程完成包权限准备，再由用户明确启动新 Run；WorkBoard 不代授权、不重放旧 Prompt，也不把认证码/令牌写进本说明。

网页 API 也明确区分“CaseIQ 正在准备，Prompt 尚未启动”和“准备已停止，没有原生消息”，不让失败 Run 永久显示成等待新消息。活跃的 CaseIQ 网页进程使用与 CLI 一样的所属原生控制判断，不再误按外部 Terminal 探测或禁用其正常队列。

浏览器已在该失败 Work 上确认默认 Conversation 能显示实际启动/包权限提示和 FAILED 状态。另用仅浏览器侧的合成历史响应验证了“消息出现后移除启动诊断，自动显示正常 Conversation”；拦截随后撤除，真实失败状态保留。没有写入合成历史、创建 Run、重跑用户 Prompt、修改 CaseIQ 源码或代办认证。

### OAuth 检查与后续 Run 的认证失败

真实诊断确认：同一 Work/Session、home、原启动器、CLI 1.0.107 与 MCP 配置路径完全相同的情况下，原生连接能列出 10 个工具，但只读 OAuth 探测仍可能返回 `401 / needs-auth / initial`（探测未发送 OAuth 访问令牌）。因此，旧的连接/工具回执不是充分的登录证明，不能用它一直显示绿色“已验证”。当前实现要求额外的关联 OAuth 回执；旧回执缺少这项证据时只显示未知。原生 `tool.execution_complete` 若在检查之后明确报告 SupportIQ 需要认证，会撤销此前的绿色检查结果；不读取/公开案件工具参数或结果，不解析助手文字当控制信号，也不重放失败请求。

OAuth 探测只保存状态、原因、HTTP 状态码和固定错误类别，不保存令牌、响应头、响应正文或授权 URL。`authenticated` 仅说明探测附带 OAuth 来源令牌且运行时接受该响应；它不证明服务独立验证了令牌，也不验证案件权限。用户本人再次完成 TSE 登录后曾观察到这一状态，但冷启动复用仍未完成验证：一次后续探测没有充分回执，另一次原生窗口没有启动观察扩展，同时查到该 Work 目录没有信任记录；用户暂时无法确认窗口中的信任提示，因此不能把这一步断言为认证失败或成功。用户暂时无法确认目录信任时，诊断已取消并释放 Work；没有自动信任目录、重新登录或清理凭据。

回退为用户明确选择 **Trust this Work's exact folder**（仅当前 Work 私有 Session 的准确目录，不含父目录、全局信任或 Full access），或在原生窗口手动确认目录信任，再按官方流程登录。原生 `config.json` 可能包含 JSONC 注释或末尾逗号，显式预信任现在支持该格式并保留已有配置值；选项未勾选时不写配置。跨进程复用应在目录信任获准后再次用只读原生探测确认，不能要求用户盲目重复登录来替代这一步。

### 启动交接前的 StrictMode 可选字段错误

`CaseIQ exited without a confirmed native result. The request will not be replayed automatically.` 是缺少关联原生结果的保护提示，本身不等于 SupportIQ 登录失效，也不证明每次都是同一原因。

本次已确认的一类原因是 `The property 'authenticationOnly' cannot be found on this object`：普通任务按协议可省略“仅认证”标记，但原 CaseIQ 会启用 `Set-StrictMode -Version Latest`，WorkBoard 新增的终端提示判断直接读取缺失属性，因而在写出 invocation 后、调用原生 delegate 前失败。该次没有 journal、接受握手或 native-result；错误不是案件工具返回的业务失败，也不是后来的动画显示逻辑造成的。

WorkBoard 包装器现在在进入原启动器前，仅给缺失的可选布尔标记 `authenticationOnly` / `disableNativeAutoUpdate` 补上内存中的 false 默认值。已有 true/false 值不变，不重写冻结请求、不关闭 CaseIQ 严格模式，也不修改 CaseIQ。两套合成启动器同步启用真实上游的 StrictMode，覆盖普通请求、旧请求省略标记和独立认证的回归。

历史失败记录保留，不因修复改为成功，原请求不会自动补跑。对于其他缺少回执的原因，仍应检查对应 Run 的实际错误和关联回执，不能一律推断任务未执行或盲目重复请求。

### Windows keyring 资源错误

`failed to move active token in keyring: Not enough memory resources are available to process this command` 是 GitHub CLI 写 Windows 凭据存储失败，不等同于普通 RAM 不足，也不能据凭据条目数量断言固定上限。先用一次性、非敏感凭据测试写入能力，随后只清理该测试项；反复扫码或重跑 CaseIQ 不能修复底层写入故障。

凭据记录较旧不证明缓存无人使用。若经获准的宿主维护流程确需重置 OAuth 状态，应事先核对完整凭据组的归属及配套分片，取得明确授权，并在安全写入恢复后停止；被重置的工具之后可能需要重新认证。不要单删分片，也不要批量清空凭据管理器。

安全写入恢复后，用户可按获准的流程确认 GitHub CLI 包权限（`gh auth refresh --hostname github.com -s read:packages`）。如果 GitHub 包元数据访问正常，而 npm 仍返回 E403，请检查 npm 是否仍使用旧授权，按 CaseIQ 安装维护者的流程更新认证配置。这个步骤无需运行任务 Prompt。

npm 的文件认证机制可能把包令牌写入用户的 `.npmrc`；不要把该文件、令牌、设备验证码或备份提交到 Git，也不要把启用不安全的凭据存储当成修复。

可用 `npm view <经批准的包名> version` 单独核对包访问。查询成功只证明包访问链路可用，不代替后续安装、企业 MCP/模型或真实案件验证。

### npm 12 跨 registry 下载限制

SafeWright 的 `EALLOWREMOTE` 与前面的 GitHub 包认证不同：npm 12 默认 `allow-remote=none`。如果依赖的元数据仍指向另一个旧 registry 主机，npm 会拒绝未识别为当前 registry 的 tarball 下载。安装失败后的 `EPERM` 清理警告不是主要错误。

已检查当前 npm 的官方完整 URL 前缀重写实现，并在独立临时 prefix/cache 中实测以下方式：只把已核对的旧 feed 前缀映射到**现有批准 registry**，保持 `allow-remote=none`，不改变全局配置、不换外部源。安装成功，`safewright --version` 返回 `0.9.4`；没有修改 CaseIQ，也没有执行安装脚本或启动浏览器/模型。

如宿主安装维护者已核对并批准该映射，可使用下列单次配置，将占位符替换为获准的实际值：

```powershell
$package = '<approved-safewright-package-spec>'
$oldRegistryPrefix = '<approved-legacy-registry-prefix>'
npm.cmd install -g $package `
  --userconfig "$env:USERPROFILE\.npmrc" `
  --replace-registry-host="$oldRegistryPrefix" `
  --allow-remote=none --ignore-scripts
safewright.cmd --version
```

该重写只适用于宿主已确认的旧 feed 路径和现有 registry；不能照搬到其他未知来源，也不应改为全局 `allow-remote=all` 或不受限制的下载。`--ignore-scripts` 保持安装脚本禁用；预构建 CLI 能启动也不证明所有浏览器工作流已就绪。

如果接着出现独立的 `EPERM` 安装错误，应先核对占用/ACL，只处理已确认属于该包的路径，不删除整个全局 `node_modules`。SafeWright 是可选浏览器工具，普通 CaseIQ 可以继续准备；但 `npx` 仍继承 npm 下载限制，不能把原 launcher 的“npx 仍可用”提示当作实际验证结果。

## 网页 Runtime 回归与边界

### PowerShell 宿主与长路径

真实网页复测发现 Windows PowerShell 5.1 会把长达 264 字符、已经由 Node 成功写入的 MCP 配置判成不存在；较长的 instruction 输出也会触发路径错误。此时认证、包和文件生成本身可能已经成功，却仍显示“Could not generate the SupportIQ MCP configuration”，不能只根据这句话把错误归到 SupportIQ。

CaseIQ 网页包装进程现使用由宿主解析并核对版本的 **PowerShell 7（pwsh.exe）**，不修改 CaseIQ 源码、不缩短或迁移现有私有会话目录，也不使用 ExecutionPolicy Bypass。缺失、不兼容或探测失败时明确报告；安装状态单独说明网页执行不可用，不伪装成已就绪。普通 CLI/SDK 不受影响，旧 Terminal 的启动方式保留。

新增回归验证真实包装进程可以读写超过 260 字符的 instruction 路径，并覆盖缺失宿主、旧/无效版本和探测失败。宿主选择不改变 Session 的目录和归属；CaseIQ commit/hash/CLI 版本作为每次 Run 的观测值，不再构成跨 Run 锁定。PowerShell 7 应按批准的宿主安装流程准备，WorkBoard 不自动安装系统组件或修改 Windows 长路径策略。

### CaseIQ 收尾目录重命名

真实原生模型已返回合成标记后，CaseIQ 的 `Rename-CaseIQSessionHome` 会将新建临时 home 改名为它包含的 Copilot Session ID。WorkBoard 若继续读启动时的路径，会把已保存的历史误判为 ENOENT；这是集成收尾不匹配，不是模型没有输出。

私有绑定保留不可覆盖的启动 `home`，并在关联的 accept/native-result/launcher-result 校验通过后，允许记录一次不可覆盖的 `finalHome`。候选只能是同一父目录下、名字精确等于该 Session ID 的普通目录，须仍在原私有命名空间并有该 Session 的历史；不扫描“最新目录”，不跟随 junction 去别的命名空间，不改安装/用户/Work/主机/CLI 身份。

历史、Pins 和后续准备读取最终 home；Resume 仍使用原 Session 和冻结配置。正常完成及具有可靠收尾回执的取消都会保留此位置。WorkBoard 不搬动原生文件，只适配原启动器已经完成的改名。旧绑定无需数据库 migration，缺失回执或历史时仍明确阻断，不凭 stdout 猜测恢复路径。

### 本轮细节优化

- Runtime 切换只改变引擎，不清空用户已选模型、Agent、超时，也不覆盖 CLI/SDK 的输出和权限偏好。CaseIQ 界面显示实际生效的自管权限及 JSON 传输；切回 CLI/SDK 恢复原选项，Auto 明确表示 CaseIQ 默认模型。
- 输出按 launcher/native 及 stdout/stderr 分开、有界地拼成完整行，再遮蔽私有目录并发送到日志和 SSE；网络/进程分块不再被当作 JSON 事件边界。UTF-8 分段、Windows 大小写路径、JSON 转义路径以及无换行尾部均有合成回归。
- 日志写入失败会停止所属执行并明确通知网页及服务器日志，不因为写入 Promise 已失败而丢失后续错误通知；不报告成功。回归既检查准备时的写入失败，也在原生进程实际运行后破坏合成输出目录，验证该 PID 已停止并释放自己的控制，不只是检查错误字符串。
- 重复 Run 先检查进程控制归属，不覆盖正在运行的 emitter 或取消控制。准备阶段可取消，不启动原生模型进程；自动续跑提示使用实际配置的次数上限。
- 输出区区分“检查可信安装”“准备已接收”和“原生 Prompt 进程已启动”，仅在相应事实出现时显示阶段提示；这些状态都不表示任务或遥测已完成。
- 宿主 CaseIQ 源码在本轮外部更新后，原指纹检查正确阻断了旧注册。只读审查确认新增 `COPILOT_ENTRA_ONEAUTH` 设置不改变 Prompt/JSON/握手接口；WorkBoard 现在保留这一显式宿主偏好，不强制登录方式，也不把 WorkBoard 凭据转交给子进程。旧会话继续按其原 commit/launcher/CLI 冻结身份验证，不自动迁移。

网页执行器共 18 项回归：原样 Prompt、私有 home、同会话 Follow Up、取消/超时、同 Provider 续跑/模型回退、安装冲突、分段输出、IO 失败、重复 Run、次数边界与完成/取消后的目录改名。这些自动化测试只运行 WorkBoard 的假启动器/假 CLI；上面的真实模型复测单独记录，不混为 fixture 结果。

实际验证并修复了两项 Windows 宿主问题：Node 继承 PowerShell 7 模块路径时，Windows PowerShell 可能误加载安全模块；重复设置私有目录 ACL 时，`Set-Acl` 可能意外要求 `SeSecurityPrivilege`。当前仅在子进程优先使用自身内置模块，并只读取/写入 owner 与 DACL、保留 SACL，不提升权限、不放宽私有目录。

网页内部继续使用私有 `prepared → accept → native` 握手。只信任关联 ID/nonce/序号匹配的 journal；普通 stdout、模型回答和 TUI 文本不能成为控制信号。缺少原生收尾记录时不自动重放，完成判断还要求无未结束工具/子代理及原生完成证据。

本轮完整套件使用 `npm test -- --maxWorkers=2`：**1147 项，1140 通过、4 跳过、3 失败**。CaseIQ/原生身份相关 **159** 项、Conversation/输出/原生路由相关 **100** 项与 Docs/Markdown **41** 项全部通过；这些分组存在交集，不作为总数相加。三项失败仍是上一阶段已复现的基线：两项 Follow Up 默认 `queue:false` 断言，以及 Windows 进程清理墙钟阈值；没有靠改默认值或放宽阈值掩盖它们。

类型检查、全量 lint 与项目生产构建通过；lint 保留 2 项原有 warning。postbuild 清理已声明的宿主私有引用；独立检查全部 75 份最终 trace，私有引用与外部 CaseIQ 源码文件均为 0，六个桥接脚本、独立 Zod 和两份原文保留。Turbopack 的动态 trace warning 仍如实保留。

SQLite 的 CASEIQ 枚举不需要物理列变更；只读 schema diff 还显示既有 WorkSteeringMessage 差异，本轮未应用其重建 SQL，也没有执行 reset/db push。测试门户复用原有独立测试库，不修改用户已保存的 Work。

隔离界面测试确认 Runtime 中可选择 CaseIQ，选择后不再出现 Create & Open Terminal；新建 Work 实际保存 CASEIQ 与原样用户 Prompt。普通 Execute 请求明确发送 `engine=CASEIQ`，没有 Terminal POST；网络拦截只验证错误反馈，未调用真实模型或伪造成功 Run。原始启动器与模型的实际执行结果单独见[真实网页复测](#真实网页复测)。

上述仅检查界面用的临时 Work 与其专属空目录已清理；用户 Work/Run 与本轮真实复测 Work 保留，测试门户继续运行。只读安装可用仍不证明企业 SSO、所有工具或遥测送达已完成验证。

此前偏好与窄屏浏览器检查验证 CLI → CaseIQ → SDK → CLI 往返：原 Full access、Readable text、Agent 和超时均保留；CaseIQ 只展示自管权限及 JSON 传输。390 像素窄屏无横向溢出，文档的新锚点未被顶栏遮挡。该阶段未创建 Work 或运行模型；门户的原 2 个 Work、1 个 Run 保留。对已外部更新的 CaseIQ 完成只读重新注册后，门户检查再次返回可启动、103 个支持包与正确的新 commit。

本轮合成文本已调用真实模型并验证同 Session 的普通 Follow Up；企业 MCP 授权、客户案件、必要 hooks/工具与遥测送达仍需单独获准验证。合成进程或普通文本成功都不等于这些发布条件已完成。

## 已落地的模块解耦

安装探测、纯身份判断和会话生命周期已经分开维护，不再把“读取安装状态”绑定到 Prisma 或私有会话存储的加载。这里描述的是实际代码边界，不是未来 Provider 框架的计划。

| 模块 | 实际职责 | 不应承担的职责 |
|---|---|---|
| `caseiq-options.ts` | 浏览器/服务端共用 DTO 与输入校验、浏览器请求防重复状态 | 数据库、原生进程、宿主安装路径解析 |
| `native-session-identity.ts` | 分别计算安装路径身份与单次调用指纹；版本仅用于 Run 记录 | 文件读写、Prisma、私有 binding 加载 |
| `caseiq-errors.ts` | 共享同一个错误类及 HTTP 状态语义 | 安装探测、数据库、隐式回退 |
| `caseiq-installation.ts` | 读取安装根目录与当前版本，检查实际调用能力与目录；维护提交包索引与进行中探测合并 | Prisma、会话绑定存储、准备握手、创建/恢复原生会话 |
| `native-session-bindings.ts` | 私有绑定持久化、归属/主机/home 不变；允许更新版本观测 | 安装目录发现、模型会话控制 |
| `caseiq-integration.ts` | 网页 Prompt/旧 Terminal 共用的准备请求、私有目录、prepared/accept 握手及模型归属更新 | 同时充当只读安装 API，或缓存已经完成的就绪结论 |
| `caseiq-runner.ts` | 网页隐藏子进程、journal 流、取消/超时、同 Provider 续跑和完成判断 | SDK 会话、自动打开 Terminal、覆盖 CaseIQ 权限或回退裸 CLI |
| `work-executor.ts` | 根据明确的 Run engine/provider 派发，保留用户 Prompt、附件、原生会话及结果快照 | 把所有非 SDK 引擎默认为普通 CLI |
| `terminal-resume.ts` | 现有终端入口、Provider 分流、历史同步和收尾 | 用普通 CLI/SDK 替换 CaseIQ，或绕过冻结身份 |
| `protect-runtime-traces.mjs` | 构建/准备启动时的私有部署资产边界 | 删除原始宿主文件，或伪装已经复制的 standalone 私有数据为安全 |

```text
Runtime CaseIQ -> 普通 Work / Run / Follow Up API -> Work executor -> CaseIQ web runner
所属 Work API -> 安装只读报告 -> 纯身份指纹 + 共享错误
网页 Run / 旧 Terminal -> 共享准备协调 -> 安装重新校验 + 私有绑定 + Prisma + native bridge
私有绑定 -> 纯身份指纹 + 私有运行路径策略
```

Work API 仍执行所属用户/Work/Run 的授权和安全投影；把安装探测拆出去不等于移除访问控制，也不把用户绑定放进共享主机报告。依赖方向是生命周期调用安装校验，不能反过来让只读安装模块导入生命周期、Prisma 或私有 session 存储。

本轮扩展 WorkEngine 的 CASEIQ 取值，不改变原生协议、绑定格式或兼容性指纹字节格式。SQLite 枚举使用 TEXT，无需为此重建数据表；不执行 `db push` 或 reset 来掩盖其他既有 schema 差异。迁移前捕获的 Windows 指纹向量及只读模块/纯身份依赖边界回归继续保留。

## 首次使用：从注册到原生会话

**以下是旧 Native Terminal 流程的兼容记录，不是当前网页 Runtime 的使用步骤。** 新用户直接使用上面的 Runtime → CaseIQ → Create & Run。只有保留旧 Terminal Run 的 Work 才显示 `CaseIQ Terminal (legacy)`；旧会话不会自动转换成网页会话。

1. **先部署 WorkBoard 的集成代码**：执行下文的增量 migration、生成客户端和构建；确认没有需要保留的运行中任务后，再重启实际提供网页的 WorkBoard 实例。只构建、不重启旧实例，不会加载新的浏览器功能。
2. **由宿主注册可信安装**：设置 CaseIQ 安装路径及已核对的 launcher 指纹。注册不是下载或安装，不会修改 CaseIQ 仓库。
3. **使用独立 Work 文件夹**：不能使用 CaseIQ 安装目录、其子目录或私有运行目录作为工作区。保存本次 Work Prompt，只提供获准使用的合成素材或案件内容。
4. **打开 Work → CaseIQ**：页面先执行只读安装检查，列出实际支持包和限制。`Native launcher is available` 只证明启动接口检查通过，不证明私有包、SSO、模型或所有技能已就绪。
5. **明确选择新建还是恢复**：新建使用表单里的支持包、可选案件号和 Prompt 开关；恢复使用上次会话的冻结配置。表单不自动继承旧案件号，除非明确点击复用设置。
6. **点击 Open CaseIQ Terminal**：允许原 launcher 开始准备。它可能安装缺失的依赖、要求登录或进入原生交互；WorkBoard 不会静默代答，也不会提前跳过这些步骤。
7. **核对接收回执和原生终端**：接收成功后可点击 `View accepted Run`；若提示未确认，先检查终端和 Run 历史，不要重复点击或重放 Prompt。
8. **在原生终端完成输入和审批**：附件、身份验证及后续问题都在原生终端处理。结束后查看对应 Run 和原生历史；没有完成证据时，退出码 0 也可能保留 UNKNOWN。

首次验证应先使用经过批准的合成数据，默认不勾选发送 Work Prompt。不要用真实客户案件验证私有包或企业认证是否可用；合成 UI 测试通过也不等于获得客户数据使用批准。

### 新建、恢复和复用设置的区别

| 操作 | 会话与配置 | 是否启动或发送 |
|---|---|---|
| Open CaseIQ Terminal | 分配新会话，使用当前表单配置 | 明确启动；仅勾选时发送已保存 Prompt |
| Resume latest CaseIQ Terminal | 使用原会话、原 home、原支持包与案件号 | 明确恢复；不自动重发初始 Prompt |
| Use last CaseIQ settings | 只填入已验证归属的支持包和案件号 | 不启动、不恢复，并关闭 Prompt 自动发送 |
| Retry environment check | 只重新读取安装和会话状态 | 不创建模型会话，不重发任何启动请求 |

**修改表单只影响新建，不会改变 Resume 的支持包或案件号。** 换案件、支持包或安装版本，应明确创建新会话，不能覆盖旧会话绑定来实现。

## 最近 CaseIQ 会话与设置复用

CaseIQ 面板独立显示当前 Work 最近的一次 **CaseIQ Run**，不会因为后来执行了普通 CLI/SDK 就丢失 CaseIQ 的恢复入口。可以查看对应 Run，并在检查通过后直接恢复原生会话。

- **运行中**：显示原生会话仍在运行，并每 5 秒刷新状态；不会同时恢复第二份会话。网页无法代替原生终端做审批、输入或停止。
- **可恢复**：必须仍有已绑定且非空的原生历史、已完成的源代码基线，以及同一安装位置、launcher 指纹、CaseIQ commit、CLI 路径和版本。历史消失、空文件或身份变化会阻止恢复，而不是改用默认 home 或新的 Provider。
- **暂不可恢复**：面板显示原因，包括绑定/历史缺失、版本变化、基线未就绪、归档或宿主不匹配。新会话和恢复是不同操作，不会自动重放旧 Prompt。
- **复用上次设置**：必须明确点击，只填入已验证归属的支持包和案件号，不启动、不恢复、不发送 Prompt；“发送已保存 Prompt”重新保持未勾选。若要换案件，请显式修改案件号。
- **多个支持包**：可按名称或 ID 搜索，搜索框按 Enter 不会打开 Terminal。已选包即使不匹配筛选条件也保持可见；可以逐个移除或清空。最多 32 个，页面和服务端都校验，不会截取前 32 个后假装全部发送。
- **缺失的旧支持包**：仍显示为 unavailable 并提示检查，可以只移除该包而保留其他选择；不会悄悄删包或替换。服务端启动时仍按当前目录校验。
- **案件号**：可留空；填写时最多 200 个字符，仅允许字母、数字、点、下划线和连字符。不从 Work 名称、目录或其他会话猜测案件号。

会话绑定固定所属用户、Work、主机、安装路径、原生 Session 与 home，不能借版本更新换成其他人的会话或目录。commit、launcher hash 与 CLI 版本只是最近一次观测，允许后续 Run 更新；每个 Run 和 attempt 的历史版本记录独立保留，不因新版本覆盖。已有 Session 不因版本升级被强制要求新建。

### 原生准备未确认时，Run 为什么仍占用 Work

`RUNNING` 只表示 WorkBoard 仍保留本次外部 Terminal 的运行归属，**不等于模型已经开始推理**：

- 私有 binding 尚未产生，或 binding 的 home 仍为空时，显示“原生准备尚未确认”；原 launcher 可能仍在处理包准备、认证或人工输入，不能直接建议再开一个会话。
- 对应 TerminalLaunch 已记录准备/历史同步错误时，CaseIQ 面板给出需要检查的说明，而不是继续只显示“终端已打开”。公开状态只投影错误存在及操作提示，不直接返回可能含私有路径的底层诊断文本。
- 明确观察到原生准备已结束、wrapper 退出或退出码后，沿用收尾机制处理失败；**缺少 receipt、PID 或 history 本身不是“没有运行”的证明**。
- 没有足够证据时，保留 Run 的占用并继续检查，新建/恢复入口保持阻止；即使网页父级信息尚未刷新，也按最近 CaseIQ 状态阻止重复启动。不自动判失败、释放目录、启动另一份或切换 Provider。关闭浏览器标签页也不会结束原生终端。

遇到持续准备状态，先检查原生窗口中的认证/问题，再看对应 Run 和宿主日志。若缺少可靠的启动/收尾记录，需要宿主维护者核对所属进程和记录；本集成不提供“忽略证据、强制解锁并重放”按钮。这个边界目前不能靠 WorkBoard 单方面安全消除，因此采用保留占用、显式检查的回退。

### 包装进程身份与 PID 复用

新的 WorkBoard CaseIQ 包装器在私有启动记录中保存 `wrapperPid` 和 `wrapperStartTime`。后者是 Windows FILETIME 创建标识，以字符串保留精度，不把大整数转成 JavaScript number，也不靠文件修改时间猜测进程归属。

历史活动判断和原生准备监控同时核对 PID 与创建标识。即使相同 PID 已被另一个活进程复用，也不会借用它的存活状态；仍然尊重真实会话锁，包装器退出不自动等于原生会话已结束。原生准备监控在启动宽限后限制身份查询频率，避免轮询反复启动系统查询。

身份读取的权限错误、超时或无效记录会显式报错，不当作“进程不存在”。旧启动记录没有创建标识时保留原来的 PID 兼容判断，不伪造字段，也不因此重写旧原生历史；后续新启动/Resume 会产生带标识的新记录。这不是新增网页取消能力，不会杀掉占用相同 PID 的其他进程。

## 启动回执、错误和重复请求防护

启动与恢复的结果分开处理：

| 网页结果 | 含义 | 下一步 |
|---|---|---|
| Request accepted，并有 Run 链接 | 收到格式正确的原生启动接收回执 | 查看该 Run 和原生终端；不是准备完成、任务成功或遥测已送达的证明 |
| 明确拒绝，例如输入无效、403 或 409 | 当前请求被接口拒绝 | 按错误说明处理；修复输入或原有运行冲突后再明确操作 |
| Unconfirmed，例如连接中断、408、5xx、成功状态但回执缺失/格式错误 | 服务端可能已经处理请求，不能断言“没有启动” | 新建和恢复按钮暂时锁定；先检查原生终端、最近 CaseIQ Run 和 Run 历史 |
| 已接受，但后续环境刷新失败 | 启动接收回执仍有效，失败的是只读状态刷新 | 使用 accepted Run 链接；重试环境检查，不要因此重新发送启动请求 |

未确认时，不会自动重发、切换 Provider 或换模型。检查后，必须明确点击 **I checked Terminal and Run history; allow another attempt** 才允许另一次操作。这个确认只解除浏览器防护，**不会停止、撤回或取消已经启动的原生进程**。

浏览器在发送 POST 之前，按 Work 在当前标签页的 `sessionStorage` 中记录请求 UUID 和 new/resume 类型；不保存 Prompt、案件号、支持包内容、home、安装路径或凭据。收到有效回执或明确拒绝后才清除对应记录；网络错误或损坏的回执不会当作“未执行”。刷新页面或重新打开 CaseIQ 标签仍会发现当前标签页里的未确认记录。

如果浏览器无法读取或写入这份防护记录，启动前会明确阻止请求，不静默绕过。只有检查终端和历史后才能清除记录；清除失败时仍保持阻止状态。状态刷新错误和启动错误分开显示，成功刷新不会抹掉未确认启动的警告。

这是一项**当前浏览器标签页内的重复操作保护**，不是 CaseIQ 的服务端幂等接口，也不是跨浏览器、跨主机的 exactly-once 保证。关闭标签页可能结束该存储生命周期；服务端仍执行归属、宿主、单次启动请求完整性和运行冲突检查。不要通过开新标签页绕过未确认提示。

## 为什么采用原生回退

### 1. Scope Assist 与 SafeWright 不是同一种硬依赖

- **conductor-scope-assist / scope-assist** 是 Conductor 使用的案件 scoping MCP 工具：按 Support Area Path 匹配 Scope 技能、收集必要信息并做质量反思。原 launcher 会准备这个包；准备失败可能终止启动。
- **SafeWright** 是通过 shell 调用的浏览器自动化 CLI，不是 MCP server。只有 UI-only 流程需要它；launcher 明确允许全局安装失败后继续，并提供 npx 路径。因此“全局 safewright 命令缺失”不是所有 CaseIQ 运行的硬阻断；但 npx 也受 npm 策略约束，需要单独验证，不能据该提示认定可用。
- 命令不在被检查的 PATH 中不等于服务故障，也不等于相关包永远无法使用。

`demo-scope-assist-mcp.md` 自身标注了弃用/迁移说明，其中旧 conductor-dataverse、Dataverse 和 get_case_full 示例不是本次新集成的数据接口；当前案件读取仍交给原 CaseIQ 的 SupportIQ 配置。

解决方式是不在 WorkBoard 中复制这些工具或伪装准备成功，而是在工程师明确打开原生 Terminal 后，让原 launcher 按原有规则完成准备和认证。

### 2. 原 launcher 不是严格 run-only 接口

`SkipUpdates` 不禁止安装缺失工具，也不禁止原生认证。WorkBoard 不提供静默代登录，不承诺原 launcher 没有准备副作用。

CaseIQ 子进程使用 WorkBoard 私有 npm prefix/cache，避免污染普通任务的 PATH 或清理全局 npm 缓存。包来源、隔离期和私有包认证仍遵守原 CaseIQ 逻辑。原生流程仍可能维护工程师自己的 GitHub/npm 认证配置，不能把它宣传成操作系统沙箱。

遇到私有包无权限、SSO、CFS 隔离期或交互登录问题，查看 Terminal 的原始说明并由工程师处理。WorkBoard 不切换到另一个引擎来绕过问题。

### 3. 问答和审批不能由网页批处理偷偷代答

Scope 流程需要交互地补齐案件信息；某些 MCP 或技能也需要认证、权限或人工输入。原生 `-p` 能接收 Prompt，不代表所有 CaseIQ 技能适合无人值守执行。`--no-ask-user` 也不是合法的“自动补答案”方案。

原生 Terminal 保留这些现有交互，因此是当前可用的安全回退路径。

### 4. 扩展支持不等于就绪与送达已验证

当前 CLI 有 prompt 模式和插件支持，不能根据旧文档笼统断言“`-p` 不支持扩展”。但配置存在、插件目录存在、server connected、tool count 或进程退出 0，也不能证明本次两个报告工具已注册、诊断前已就绪或遥测已经送达。

CaseIQ 的 debug `joined` 记录可用于兼容性研究，但不是稳定的生产机器协议，还可能包含正文。WorkBoard 没有把这种后验诊断日志伪装成完整的运行前就绪保证。

因此 Web batch 能力保持不可用。将来只有通过固定版本、真实合成的正负向测试，证明必需工具就绪和阻断顺序后，才考虑开放；不靠 SDK、PTY 画面解析或扩大权限绕过。

## 安装注册与部署

受信任安装路径由宿主配置，不从浏览器、Prompt 或模型输出接受任意 executable。

方式一：在 WorkBoard 的本地环境设置：

```powershell
$env:WORKBOARD_CASEIQ_ROOT = 'C:\path\to\CaseIQ'
```

WorkBoard 不再要求固定 commit、固定 launcher hash、精确 CLI 版本、`main` 分支或干净工作区。每次 Run 只读观察当前 CaseIQ 版本，记录实际 Git commit、分支、是否有已跟踪文件修改、launcher SHA-256 和 CLI 版本；升级或修改这些内容不会单独阻止新 Run、Follow Up、认证或旧 Terminal Resume。CLI 只检查桥接所需的实际参数能力，不以版本号大小作为准入条件。不会自动 pull、切分支或修改 CaseIQ。

网页 Run 的 Raw output 会显示 **CaseIQ version: &lt;完整 commit&gt;**，下载的 `run.json` 在 `caseIqVersions` 中按 attempt 保留版本观测；私有 `request.json` 同样记录该次版本。记录在原生进程启动前写入，失败、取消和原有 fallback/continuation 仍保留已观测信息。旧 Run 不回填或猜测新版本；旧格式请求与绑定继续可读。Session 的版本字段可更新，但归属与 home 不变，历史 Run 元数据不会被改写。

版本不构成跨 Run 门槛，不等于取消实际执行约束：缺少启动器/依赖、无法读取 Git 版本、协议不支持、归属或路径不符、审批冲突仍明确报错。同一个 attempt 已记录的启动器或 CLI 若在握手中途被替换，需要重开该 Run；这仅保护该次调用的一致性，不要求恢复旧版本或重新登记。

也可以使用不提交到 Git 的 `data\caseiq\installation.json`：

```json
{
  "root": "C:\\path\\to\\CaseIQ"
}
```

两种注册方式不要混用：

| 注册项 | 环境变量模式 | JSON 模式 |
|---|---|---|
| 安装根目录 | `WORKBOARD_CASEIQ_ROOT` | `root` |
| 历史版本字段（忽略） | `WORKBOARD_CASEIQ_LAUNCHER_SHA256`、`WORKBOARD_CASEIQ_COMMIT`、`WORKBOARD_CASEIQ_CLI_VERSION` | `launcherSha256`、`sourceCommit`、`nativeVersion` |

**只要 `WORKBOARD_CASEIQ_ROOT` 非空，就使用该环境变量注册，不合并 JSON。** 未设置该根目录变量时，才读取 JSON 注册。历史版本字段保留读取兼容但不参与校验，也不要求用户先删除旧配置。安装和运行目录仍由 WorkBoard 宿主配置，不从网页请求接受。

注册读取与实际安装校验也分别执行：

- 环境根目录取去除首尾空白后的值；有效选择环境变量模式后，**完全不读取**本地 JSON，即使 JSON 文件损坏、不可读或误建成目录，也不干扰该模式。
- 环境模式本身无效时明确拒绝，不转而尝试 JSON。只有历史版本变量、没有环境根目录时，仍读取 JSON，不偷偷合并两种来源。
- JSON 接受普通 UTF-8 及 Windows 工具可能写入的 UTF-8 BOM；读取时处理 BOM，但不重写原文件。
- JSON 语法、未知字段、相对根目录或空字符错误有明确不可用提示，不回显原始配置正文。历史版本字段的值被忽略。缺失文件报告未注册；读取失败记录宿主日志，并返回不可用状态，而不是在错误报告中再次读取同一文件、导致第二次异常。
- `configured` 是注册来源的诊断标志，不是安装有效性证明；注册源存在但错误或无法读取时可能仍为 true，`launchable` 必须为 false。启动和恢复仍要求完整安装校验，不能仅凭该标志继续。

版本只记录、不锁定；只读查看当前版本可以使用：

```powershell
git -C 'C:\path\to\CaseIQ' --no-pager rev-parse HEAD
git -C 'C:\path\to\CaseIQ' --no-pager status --short --untracked-files=no
Get-FileHash -LiteralPath 'C:\path\to\CaseIQ\caseiq.ps1' -Algorithm SHA256
copilot --version
```

不需要为正常版本更新计算新 hash 或修改注册来消除阻断。CaseIQ 的升级和代码变更仍由其维护流程负责；WorkBoard 不执行 CaseIQ 的 pull、checkout、reset 或自动修复。

### 支持包来源与安装目录校验

支持包目录不再靠扫描磁盘上所有文件夹生成，而是从**本次已核对的 Git commit** 中读取直接位于 `support-packs\<id>\pack.yaml` 的清单，再校验实际工作树中的目录和 manifest：

- 未跟踪或仅放在磁盘上的新包，不会出现在目录中，也不能通过网页传入其 ID 来启动。不会删除或改写这些文件；自定义包需要由安装维护者审查并纳入可信提交后重新验证。
- ID 延续现有原生 bridge 的约定：小写字母或数字开头，后续只允许小写字母、数字、点、下划线、连字符，最多 100 个字符；目录名必须与 `metadata.id` 完全一致。大小写不符、嵌套 manifest 或其他不受支持的路径不会自动改名或别名映射。
- `runtime`、`telemetry`、支持包根目录和已注册包目录必须是普通目录，不支持符号链接或目录 junction；manifest 必须是普通文件。目录链接、manifest 缺失/异常、ID 不一致时，安装验证失败，不返回“成功但少了几个包”的目录。
- 必须有已提交且有效的 `platform` 支持包，不能把平台包缺失默认为可启动。
- 当前安装的只读核对结果仍为 103 个受支持包。包清单读取有明确输出上限，不因仓库包含较多技能文件而截断清单后继续运行。

这些校验只验证本机安装和可选择包的来源，不是操作系统沙箱，也不证明每个 MCP、遥测工具或模型已就绪。运行期间仍不要更新 CaseIQ；新建和原生准备握手会继续核对冻结身份。

### 只读探测的复用边界

为避免多个 Work 面板或状态刷新同时重复启动 Git/CLI 检查，同一服务进程内只合并**仍在进行中的**安装状态探测。成功、不可用或异常结束后都会释放这份进行中状态；没有就绪结果 TTL，下一次独立手动刷新会重新核对安装。

包目录只缓存“规范安装根目录＋冻结 commit”对应的不可变**包 ID 索引**，最多保留一项，提交或根目录改变即更换；同一项并发加载只运行一次 `ls-tree`，Git 读取失败不会留在缓存里。不缓存工作树有效性、manifest 内容、目录链接判断、CLI 版本或用户会话；即使命中索引，仍重新读取并校验实际目录及 manifest。

用户/Work/Run 的归属和私有绑定不参与这份共享主机报告。新建、Resume 和原生准备接收继续直接执行安装校验，不把网页刚显示的“可用”或进行中的只读报告作为启动授权。

本轮用 Git 原生 TRACE2 验证：五次并发目录读取加一次后续读取，`ls-tree` 从原来的 **6 次降为 1 次**。真实隔离 HTTP 验证中，五个同时请求各返回同样的 103 个支持包，但只发生一组 checkout 检查；再发起一次独立刷新，`rev-parse`、分支和 tracked 状态检查均重新执行，而不可变包索引仍只读取一次。该批次本机实测 1183ms，仅作为观测结果，不作为跨机器时延承诺。

研究中遇到过“上游 commit 推进，但实际 launcher 指纹不变”的情况。把整个仓库永久写死到初始 commit 会误阻塞新会话，因此采用启动接口固定、会话 commit 固定、可选整仓锁定的分层约束；不通过修改或回退 CaseIQ 来解决。

也遇到过本机 CLI 从 `1.0.105` 更新到 `1.0.106` 的情况。解决方式是对新会话重新检查必需参数并记录实际版本，而不是下载旧版或忽略校验；旧会话不会跨版本静默恢复。能力检查不进行模型推理，不宣称覆盖所有产品技能。

部署包含增量 migration：只给 Run 新增可空 `providerId`，不改 CLI/SDK engine 枚举，不重写旧历史。

```powershell
npx prisma migrate deploy
npx prisma generate
npm run build
```

重启正在服务的 WorkBoard 实例后加载新功能。不要 reset 数据库或破坏性回退 migration。

### 构建产物中的私有数据保护

当前 Next.js/Turbopack 的动态文件追踪有已核对的兼容问题，普通路由排除规则不能单独作为 instrumentation 产物的安全证明，参见 [vercel/next.js#95125](https://github.com/vercel/next.js/issues/95125)。本轮实际发现 instrumentation trace 曾包含宿主运行数据引用，因此不能仅凭 `next build` 成功就交付。

WorkBoard 增加 `protect-runtime-traces.mjs` 守卫，并接入：

- `npm run build` 的 postbuild；
- `npm start` 的准备阶段；
- 后台服务 start/restart/login 使用已准备产物之前，包括跳过构建的路径。

守卫检查全部 `.nft.json`，只剔除宿主私有数据的部署引用：本机 `data`、`.workboard`、环境文件、数据库及 CaseIQ/Copilot 私有运行根目录。它不读取客户正文、不删除原始文件、不修改运行绑定；正常代码、原生脚本、Zod 和说明页仍保留。无效/缺失 trace 或不安全运行根目录会使检查失败，而不是返回“干净产物”。

**如果 standalone 已把私有文件复制进产物，守卫会直接阻止启动/交付，不会通过只清 manifest 伪装成安全。** 维护者必须在受控、没有宿主数据复制的构建环境中重新准备产物。不要绕过项目构建流程直接运行 `next build` 后按未经检查的 trace 发布，也不要把本机数据目录作为部署资产。

本轮最终对 75 份 trace 做独立复核：私有运行数据引用为 0，六个原生所需脚本、独立 Zod 依赖与两份 CaseIQ Markdown 均保留。Turbopack 本身仍可能输出动态追踪 warning；这是保留并说明的构建器限制，不把告警静默吞掉或冒充已经修复上游。

## 源码不修改的边界

- 所有集成代码、bridge、delegate、配置、页面和 migration 都维护在 WorkBoard。
- 启动前只读核对 CaseIQ root、launcher hash、commit、分支和 tracked 工作树；不修复上游目录。
- 使用 `-NoCasePicker -SkipUpdates`，跳过历史迁移/选择路径，避免扫描其他案件。
- 任务工作目录不得是 CaseIQ 安装目录或它的子目录。请使用独立 Work 文件夹。
- 不通过 ExecutionPolicy Bypass 绕过脚本策略。策略阻止脚本时明确报告，由工程师按宿主规则处理。
- 运行中不要更新 CaseIQ。版本改变会阻止 Resume，要求明确创建新会话或重新验证；已保存的历史仍可读取。

## 会话、数据与认证

实际原生绑定保存在私有运行目录中，包含所属 Work/用户/主机及真实 home，不放进公开 Run DTO、SSE 或可下载快照。私有目录在 Windows 上使用当前用户和 SYSTEM 的 ACL。

每个逻辑会话有独立的 `CASEIQ_HOME` 与 cases root；Resume 沿用同一命名空间。这避免不同案件共享 mapping/settings 文件或误用“最新 session”。安装依赖的 prefix/cache 可以共享，首次初始化建议先完成一项原生启动再并行其他案件。

独立手工 `caseiq` 的旧历史不会被自动导入；要恢复由 WorkBoard 打开的会话，使用 WorkBoard 的 **Resume in Terminal**，不要手工猜测 home。原生交互历史不会自动回写 Work 的 Prompt 文件。

WorkBoard 不读取 OAuth 缓存正文、不在 JSON 中 dump 整个环境、不复制登录令牌，也不替工程师建立客户租户会话。认证仍走原 CaseIQ 的 GitHub/Corp/TSE 路径。

Prompt、结果、原生历史、CaseIQ 的必要正文遥测和本地运行数据可能包含敏感内容。仅用于获准的数据/宿主范围；工程实现或合成测试不替代客户数据使用批准。WorkBoard 不新增重复的 CaseIQ 正文上传代理。

私有数据不自动纳入 Work 文件浏览、目录快照或复制。归档不会删除原生 history、认证状态或客户产物；清理和备份应由宿主按已批准保留策略执行，先确认所属终端已停止，不删除其他会话。

### 运行目录、迁移和备份

默认私有运行根目录为用户目录下的 `.workboard\caseiq\<WorkBoard 工作目录散列>`。宿主可以设置 `WORKBOARD_CASEIQ_STATE_ROOT` 指向专用私有子目录；不允许直接使用用户目录、项目根目录或文件系统根目录，也不能放进 CaseIQ 安装目录或任务工作区。

| 数据 | 保存位置与用途 | 注意事项 |
|---|---|---|
| Work / Run / `providerId` | WorkBoard 数据库 | 保留 CaseIQ 归属，不能把 providerId 清空以绕过原生恢复校验 |
| 本机安装注册 | 环境变量或忽略 Git 的本地 JSON | 不提交个人安装路径；不当作凭据库 |
| 私有 binding | 运行根目录的 bindings | 包含实际 home、用户/Work/主机及冻结身份，不作为公开 DTO 导出 |
| 原生 home / cases | 运行根目录按逻辑 session 隔离 | 原生历史和产物可能敏感；恢复必须继续使用该命名空间 |
| 请求、接收与原生收尾记录 | 运行根目录及 WorkBoard 的 terminal-launches | 用于原生握手与状态同步，不从终端画面推导机器控制指令 |
| npm prefix/cache | WorkBoard 私有运行根目录 | 不清理系统级 npm 缓存，不替代原 launcher 的包认证 |

移动 WorkBoard checkout 或更改启动工作目录，可能改变默认运行根目录的散列。只复制数据库不足以恢复原生会话；不要在新位置猜测最新 Copilot home。停机维护时应保留数据库、原私有运行根目录及本机注册，核对 ACL/所属宿主，再由维护者明确配置所保留的专用根目录。恢复仍须通过原安装、版本和归属检查。

不要把运行目录、原生历史或认证材料复制到公共附件、Git、合成测试 fixture 或不受控备份中。清理前确认所有所属原生会话已停止，并遵守已批准的保留策略。

## 结果与故障处理

- Run 请求被接受、或旧 Terminal 已打开，都不表示任务完成。网页 Conversation 会显示实际准备日志；只有原生 Prompt 进程的启动证据和会话消息才表示进入模型执行。
- CaseIQ 的退出码 0 还需要本次完成证据、没有未结束工具/子代理，才会判定成功。没有证据或强制关窗保留 UNKNOWN，不自动重放 Prompt；已知的实际退出码仍保留，UNKNOWN 不等于“没有退出码”。
- 私有绑定缺失、非关联的 home 改变、版本改变、未知 pack、跨主机或跨 Work 归属冲突会明确拒绝，不落到默认 Copilot home。原启动器收尾的精确改名只按上述关联 finalHome 流程处理。
- 旧 Terminal 自动发送的 Prompt 过长时明确提示，保留原文；网页输入或原生命令参数不受支持时也明确报错，不截断文本。
- 网页准备失败时查看 Conversation 的启动输出与 Run 错误；先处理被指出的宿主认证/依赖问题，再明确新建同 Provider Run。旧 Terminal 会话才在原生窗口处理；不会自动调用普通 CLI、SDK 或另一个模型。
- 网页 CaseIQ 需要 Windows 执行宿主、GitHub CLI 和受支持 Copilot；只有旧 Terminal 流程额外要求 Windows Terminal。不自动安装系统级组件。

### 按症状排查

| 症状 | 优先检查 | 处理与回退 |
|---|---|---|
| CaseIQ 没有注册或按钮不可用 | 当前宿主是否使用了预期的环境变量/JSON、Work 是否归档、宿主是否匹配 | 修正 WorkBoard 本机配置并重新检查；不要在网页填写可执行路径 |
| launcher hash、main/工作树或 commit 不通过 | 是否发生了外部源码变化、分支切换或手工固定 commit | 保持阻断，交由安装维护者审查；WorkBoard 不改或回退 CaseIQ |
| CLI 版本/参数不兼容 | 当前解析到的原生 CLI 和已固定版本 | 按宿主规则重新验证；不自动降级、下载旧版或转用 SDK |
| Conversation 只显示等待历史 | 当前 Run 的准备输出、binding/home、是否已经有 native 启动和历史记录 | 查看同页 Run startup and output；准备/认证日志不是模型回答。FAILED 且未建立 home 时明确新建，不 Resume 到默认 home |
| GitHub 要求 read:packages | 原 launcher 的浏览器包权限认证是否完成 | 按获准流程完成宿主认证；不代登录、不记录认证码、不重放旧 Prompt，也不把原会话当作已运行成功 |
| Scope Assist 未检测到 | 是否仅缺少 PATH/global shim，是否需要私有包权限 | 网页 Run 使用原 launcher 准备并显示诊断；宿主授权由工程师完成。不要把只读探测当成认证成功 |
| SafeWright 没有全局命令 | 当前任务是否真的需要 UI/browser 自动化 | 普通原生入口不因此被一律阻止；遵循原生的可选安装/npx 路径 |
| npm/SSO/私有包权限或隔离期失败 | Conversation 启动输出和 Run 错误；旧会话另查原生窗口 | 工程师按企业规则处理；不复制 token、不绕过隔离期、不代登录 |
| Terminal 没有出现或停在准备阶段 | Windows Terminal、PowerShell 策略、原生认证，以及对应 Run 的启动说明 | 保留现场检查；不要用策略 Bypass、解析 TUI 或静默重放来“修好” |
| Run 仍 RUNNING，但提示准备未确认或同步错误 | 是否尚无已验证 binding/home，是否有所属 TerminalLaunch 错误或缺失收尾记录 | 保留运行占用，检查原生窗口及宿主记录；不能仅凭缺少 receipt 强制释放后重开 |
| 新放入的包未出现，或目录校验失败 | 是否已纳入当前可信 commit、ID 是否合规、是否使用目录链接/异常 manifest | 由安装维护者审查；WorkBoard 不补提交、不修包、不返回部分成功目录 |
| Unconfirmed / 回执丢失 | 原生终端和 Run 历史是否已经出现本次操作 | 先检查，再明确解除浏览器防护；不自动重发 |
| 已接受，但环境检查失败 | accepted Run 链接仍在；失败的是 GET 状态读取 | 重试环境检查；收到回执的启动请求不要再次发送 |
| Resume 不可用 | 原绑定/非空 history/完成基线是否还在，安装版本是否变化 | 保留旧历史；明确新建同 Provider 会话，不覆盖原绑定或使用默认 home |
| 搜索后找不到已选包或旧包 unavailable | 名称/ID、当前安装目录、选中列表 | 已选项保持可见；可单独移除缺失项，不能静默换包 |
| 浏览器记录无法读取/写入 | 当前标签页是否允许同源 sessionStorage，是否有未确认记录 | 保持启动阻止，先核对终端/历史再修复浏览器存储；不静默绕过 |
| 网页 Follow Up / Queue / Steer 不可用 | 是否已有可用历史、会话是否占用，以及是否是旧 Terminal Run | 网页 CaseIQ 支持同 Provider Follow Up/Queue；Steering 仍限 SDK，旧 Terminal 仍不能网页续跑。不要修改 engine/provider 伪装成普通会话 |

### 暂停或回退集成

1. 先在原生终端完成或停止属于本集成的会话，并检查尚未确认的启动请求；网页关掉不等于原生会话停止。
2. 如需停用新建入口，撤销当前宿主的 `WORKBOARD_CASEIQ_ROOT` 注册，且不再提供可用的 `data\caseiq\installation.json` 注册；之后按正常流程重启 WorkBoard。若只撤销一处，另一种注册方式仍可能生效。
3. CaseIQ 标签仍可说明“未配置/不可启动”；不切换成裸 Copilot，不为旧 CaseIQ 会话开启网页续跑。已有记录和已绑定历史保留，不删除私有运行根目录。
4. 保留增量数据库字段和 `providerId`。不要 reset 数据库、清空 CaseIQ 归属或用尚不了解 CaseIQ Provider 的旧 WorkBoard 版本接续这些 Run。
5. 再启用时恢复经过核对的本机注册和原私有状态，重新检查当前安装；旧会话只有在冻结身份仍匹配时才允许恢复。普通 CLI/SDK 的独立任务继续使用原有入口，不接管 CaseIQ 会话。

网页 Runtime 的失败保留在网页，不自动退到 Terminal、普通 CLI 或 SDK。旧 Terminal 记录仍按原 Provider 恢复；“停用”不是把未完成的 CaseIQ 任务当作成功或转交另一个模型。

## 验证方式与剩余限制

离线测试使用假 launcher / 假 CLI，覆盖进程内代理、Prompt/TTY 参数、实际绑定握手、关联 ID、UTF-8、退出码、准备/收尾错误、取消、存储失败和原生历史恢复。新增网页测试验证用户 Prompt、同 Provider Follow Up/Queue、取消/超时和续跑；旧 Terminal 仍拒绝被普通 CLI/SDK 或网页会话接管。

不应把离线测试当作当前账号对私有包、SSO、所有产品技能、浏览器自动化或真实客户案件的完整认证。认证准备属于获准的宿主流程，网页运行器不会伪造认证成功、代答或自动打开终端。

尚未开放：SDK 专属实时 Steering/审批 UI、CaseIQ 定时自动化、自动导入独立 CaseIQ 历史、原生案件目录自动文件映射、跨主机/多副本分布式执行，以及对遥测接收端逐运行送达的承诺。普通网页执行、Follow Up/Queue、取消/超时已接入；不再用 Terminal-only 的旧限制描述这些新 Run。

### 上一阶段完整验证：Docs 与原生 Terminal

上一阶段完整运行使用（本轮网页 Runtime 的结果见上方专节）：

```powershell
npm test -- src\app\docs\page.test.tsx src\app\docs\caseiq\page.test.tsx src\lib\docs-content.test.ts src\components\MarkdownResult.test.tsx src\components\ConversationMarkdown.test.tsx src\lib\documentation-headings.test.ts
npm test -- --maxWorkers=2
npm run typecheck
npm run lint
npm run build
```

完整套件共 **1104** 项：**1097 通过、4 跳过、3 失败**；CaseIQ 与纯原生身份模块相关 **130** 项全部通过，文档/Markdown 的 **41** 项全部通过。剩余三项是此前在未修改 HEAD 独立副本中复现的基线：两项 Follow Up 默认 `queue:false` 断言，以及 Windows 进程清理的墙钟耗时阈值。没有改这些无关行为或放宽阈值掩盖问题。

此前 Docs 测试把 Quick Start 的代码块固定为两个，但源内容实际有三个；本轮直接相关的修正改为按源内容逐项统计，保留全部命令示例，不靠减少正文或盲目增大常量让测试通过。两份原文的所有目录片段也逐项与渲染后的唯一标题 ID 核对，覆盖重复标题、中文、代码围栏和双向路由转换；自定义链接与代码复制可以组合使用。

独立生产预览中，`/docs`、操作说明和原生协议均返回 HTTP 200。在 390、738、1280 像素宽度实际验证入口、目录和标题位置；先复现了窄屏顶栏遮住锚点标题，再修正并确认目标均在导航下方、页面无横向溢出。双向带片段链接、返回 Docs、返回顶部和真实代码复制通过；受控剪贴板拒绝显示明确错误，不伪装成复制成功。预览使用独立合成数据库，最终 Work/Run 均为 0；未启动真实 CaseIQ、调用模型/案件服务或修改 CaseIQ 源码。

更早的默认并发运行（当时 1061 项）还观察到历史同步的一项 5 秒超时及其连锁失败，共 13 失败；历史文件单独运行 31 项全部通过，当时限制两个 worker 后完整套件剩 4 项基线，其中 Docs 断言现已修正。默认并发的测试稳定性仍需观察，因此同时保留该历史结果，不把它归为已经解决，也不把受控全量结果描述为默认命令全绿。

新的进程身份回归先复现“错配创建标识的活 PID 被误认为原包装器”，再验证修正结果；同时实际启动合成 Windows Terminal 包装器，核对它记录的标识与操作系统读取一致。测试中的终端和 native CLI 都是 fixture，没有启动真实 CaseIQ 或发送模型请求。

只读性能回归另外验证了真实 Git 命令次数、单项索引的有界性、失败后重试、命中索引后仍拒绝文件缺失/ID 错误/目录链接，以及进行中状态共享但完成后不缓存不可用结论。真实并发 HTTP 检查与后续手动刷新也通过，没有发送启动 POST。

模块解耦回归在只读安装模块导入 Prisma、私有 binding 存储或生命周期时直接失败；纯身份模块也被禁止加载文件系统/数据库依赖。当前指纹测试分别验证安装路径的大小写等价、版本观测不影响 Session 路径身份，以及单次调用的启动器/CLI 一致性；历史五字段版本冻结策略已取消。共享错误类的 `instanceof` 和 HTTP 状态语义保持一致。

注册回归先复现了两项实际问题：环境模式仍读取被忽略的文件，以及读取失败后状态错误报告再次读文件。当前覆盖环境根目录优先、禁止来源回退/混合、Windows BOM、只含空白的根目录、缺失/不可读配置、未知字段和无效路径、历史版本字段忽略、错误正文不回显与修正后的重新检查；全部使用临时宿主配置，不接触真实 CaseIQ。独立生产服务的真实环境变量注册也通过：103 包、五次并发只读查询合并、后续独立刷新重新校验、说明页 HTTP 200，没有启动原生会话。

拆分后的生产构建在独立合成数据库上再次验证：真实只读安装仍返回 103 个支持包，五个并发 HTTP 查询只执行一轮 Git 检查，随后独立刷新会重新核对 checkout，包 ID 索引仍只读取一次；架构说明页返回 HTTP 200。此次只移动职责和依赖方向，不开放新的模型/网页能力，也不运行真实 CaseIQ。

最终全量 lint 为 0 错误、2 项原有未使用参数 warning，类型检查通过，生产构建连同 postbuild 守卫通过。构建新增 `/docs/caseiq/bridge`；最终构建检查处理了非路由入口的 73 条宿主私有引用，独立检查全部 75 份最终 trace，私有引用为 0，六个原生脚本、独立 Zod 和两份原文完整保留。原始宿主文件未删除，已复制私有数据的 standalone 场景会明确失败。

### 阶段记录：提交目录与准备状态

13 个相关文件的 201 项测试全部通过；补齐客户端活动 Run 防重复启动后，59 项针对性测试再次通过。最终类型检查、相关 lint 和生产构建通过。部署 trace 仍包含六个所需脚本和独立 Zod 依赖，没有私有运行目录、环境文件或数据库。

新增合成 Git fixture 覆盖：未跟踪包不进入目录、使用指定冻结 commit 而非较新 HEAD、忽略嵌套/不合规 ID、缺失 manifest 不返回部分目录、ID 不一致、manifest 非普通文件、根目录或单个包的 junction/符号链接，以及非法 revision 输入。所有 fixture 都在 WorkBoard 测试临时目录中创建并清理，不修改真实 CaseIQ。

实际安装只读探测通过，并将 API 返回的 **全部 103 个包 ID** 与同一冻结 commit 中的合规 manifest 集合逐一比对一致，不只是比较数量。隔离浏览器验证准备未确认/已记录错误提示、父页面状态滞后时新建和恢复仍被阻止、强制表单提交不产生 POST，以及状态就绪后恢复入口。底层私有诊断路径不进入公开状态；未执行真实原生启动、模型推理、企业认证或客户案件读取。

### 完整套件已知基线

当时完整测试另外暴露四项已有失败，并在未修改的 WorkBoard HEAD 独立副本中复现：Docs Quick Start 的代码块数量断言、两项未计入既有 `queue:false` 默认值的 Follow Up 断言，以及 Windows 进程停止耗时超过其墙钟阈值的 continuation 测试。其中 Docs 断言已在本轮文档维护中按实际源内容修正，其余三项未改动；没有通过修改无关业务逻辑或放宽测试阈值掩盖问题。CaseIQ 的新增与相关测试、类型检查、lint 和构建单独记录。

前一轮原生回退的完整测试为 1002 项：994 通过、4 跳过、上述 4 项基线失败；当时的 49 项 CaseIQ 专用测试全部通过。TypeScript、lint 和生产构建通过。构建仍提示已有 session 路径追踪告警；另外检查部署 trace，确认包含所需 bridge 脚本和独立 Zod 依赖，不包含运行目录、环境文件或数据库。

浏览器验证使用独立合成数据库：实际安装探测成功、列出 103 个支持包、原生启动按钮可用、默认不发送 Work Prompt、网页批处理限制可见、私有运行路径不出现在页面，以及独立说明页可访问。没有点击真实原生启动、发送模型 Prompt 或读取真实案件；原始包访问/企业认证仍需要工程师在 native Terminal 中完成。

### 阶段记录：恢复与设置优化

11 个相关测试文件的 165 项测试全部通过，覆盖 CaseIQ bridge、会话绑定/API/UI、非空历史校验及原有 Terminal/会话行为；类型检查、相关 lint 和生产构建通过。部署 trace 再次核对：六个所需脚本和独立 Zod 依赖齐全，没有运行目录、环境文件或数据库。

隔离浏览器验证了：两个支持包和案件号仅在手动复用时填入，复用不产生启动请求并重新关闭 Prompt 自动发送；Resume 仅请求原 CaseIQ Run 的恢复端点；安装身份变化禁用恢复；已缺失的支持包仍保留可见并提示检查；运行中按 5 秒刷新，就绪后停止轮询。实际只读安装探测仍通过并返回 103 个支持包。所有启动/恢复 POST 均拦截为合成回执，没有打开真实 CaseIQ、调用模型、安装包或读取客户案件。

### 阶段记录：启动确认、选包与操作文档

12 个相关文件的 186 项测试全部通过；随后补充搜索表单回归并修正后，35 项针对性测试再次全部通过。最终类型检查、相关 lint 和生产构建通过，既有的完整套件四项基线失败没有通过改业务或放宽阈值掩盖。

隔离浏览器合成验证覆盖了：有效回执、明确拒绝、损坏回执、网络断开、收到回执后状态 GET 失败、同一时刻重复提交、刷新后的未确认保护、损坏的浏览器记录、存储写入失败时不发送 POST、手动确认恢复，以及只向原 CaseIQ Run 发送 Resume。验证了未确认记录只包含 UUID/action，环境检查不会重发请求，已接受状态不会被后续 GET 失败误写为“未启动”。

支持包验证覆盖搜索保留已选项、单独移除缺失包、32 个可选与第 33 个被拒绝。还在合成拦截中复现了“搜索框 Enter 隐式提交启动表单”，随后将搜索控件移出启动表单；最终重新构建后的浏览器验证为搜索 Enter 产生 **0** 个启动 POST，明确点击 Open 产生 **1** 个合成 POST。已加入永久回归测试。

说明补齐首次使用、注册优先级、启动结果三态、故障表、私有状态迁移/备份及停用/回退步骤。真实安装只读探测仍通过并列出 103 个支持包；验证不运行真实 CaseIQ、不进行模型推理、企业认证或客户案件读取。

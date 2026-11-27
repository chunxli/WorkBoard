# CaseIQ native bridge: protocol and offline validation

## Reading guide

Open `/docs` → **CaseIQ Guides** → **CaseIQ native bridge** for the
authenticated web version. The web page and this Markdown share one source.

- [Offline verification](#offline-verification)
- [Private protocol](#private-protocol)
- [Limits and release gates](#what-this-does-not-prove)
- [CaseIQ operations and current status](caseiq-integration.md#当前状态摘要)

This describes the private bridge used by the **CaseIQ web Runtime**. Its
prompt-mode path powers the normal WorkBoard Prompt, output and Follow Up
workflow through the original launcher; it does not open Terminal. The same
protocol retains compatibility with explicitly requested legacy Terminal
sessions, as documented in the [integration guide](caseiq-integration.md).
Neither path uses SDK session control or modifies CaseIQ source/support packs.
Use only approved host/data scopes.

The bridge runs the existing launcher in a dedicated PowerShell process. A
process-local `copilot` function forwards version checks and delegates the
launcher's actual invocation to the resolved native executable. This depends on
the verified launcher implementation, not a CaseIQ-supported machine API.

Web prompt mode requires a resolved, version-verified PowerShell 7+ executable.
Windows PowerShell 5.1 can reject existing launcher-generated paths over 260
characters. Missing or invalid Core versions make web execution unavailable;
the adapter does not silently retry with 5.1, install system components, or
change execution/long-path policies. The legacy Terminal host is unchanged.

## Offline verification

```powershell
npm test -- src\lib\caseiq-native-bridge.test.ts src\lib\copilot-runner.test.ts
```

Tests use a synthetic launcher and a Node fixture, never the real Copilot CLI,
CaseIQ, customer MCP servers, or model credits. Executable argument overrides
are rejected unless `NODE_ENV=test`.

## Private protocol

`scripts/native-bridge-protocol.mjs` defines `workboard-native/1`.
The trusted host must resolve executable paths, validate the installation, and
create a private per-attempt directory before writing `request.json`. On
Windows, the host must apply a current-user-only ACL; POSIX file modes are not
a substitute for Windows ACLs. This prototype is not a browser-facing API.

The request includes run/request/attempt IDs, a fresh nonce, the expected
launcher SHA-256 and CLI version observed for this attempt, source commit,
branch/dirty metadata, explicit session ID, working directory,
prompt, attachments, and supported typed options. It contains no token or
arbitrary command field. An existing `bridge.claim` rejects reuse.

The original CaseIQ launcher enables PowerShell `StrictMode Latest`. Before
entering it, the wrapper materializes omitted optional boolean flags used by
PowerShell as false in memory; explicit values and the frozen JSON are not
changed. Both synthetic launcher fixtures enable the same strict mode.
Without that guard, reading a missing `authenticationOnly` property can throw
after invocation capture but before delegate execution, leaving no native
journal/result. The generic missing-result failure retains its no-replay rule;
it must not be interpreted as OAuth failure or blanket proof that no task ran.

Versions are provenance, not cross-Run admission pins. The host does not
require main, a clean worktree, an old registered commit/hash or an exact CLI
version. Root-only registration is sufficient and legacy version fields are
ignored. A later Run/Resume may observe updated source, launcher and compatible
CLI in the same bound installation. Session ownership, host, installation
paths and native home remain fixed. Web Runs record each attempt in raw output,
private requests and the downloadable `run.json.caseIqVersions` array before
spawning. Old Runs are not rewritten. Checks within one attempt still ensure
the recorded launcher/CLI match the actual invocation; source-commit changes
alone do not invalidate an accepted preparation.

### Shared OAuth storage

The optional typed `sharedOAuth` request contains a private owner-scoped root,
the native Session root and, for Resume, the exact bound home. It contains no
credential. The host scopes the root by WorkBoard user, OS account, hostname
and installation path, independently of Work/SID or source version. At the final
CLI boundary, [native-shared-oauth.mjs](../scripts/native-shared-oauth.mjs)
partitions by the actual generated SupportIQ endpoint/authentication
configuration, excluding tool lists, descriptions and timeouts. It reconnects
the Session's `mcp-oauth-config` link (along with `entra-broker-accounts` and
`entra-broker-cache` when not already plain local directories) after the
original launcher has assembled the home. On Windows hosts where a
`@techsupport.microsoft.com` TSE account is signed into Windows Account Manager,
non-authentication task runs also stage a per-attempt MCP config override via
[supportiq-mcp-bridge.mjs](../scripts/supportiq-mcp-bridge.mjs) so SupportIQ
acquires TSE tokens directly from Windows WAM without colliding on shared
Windows Credential Manager OAuth entries; `authenticationOnly: true` requests
keep native HTTP OAuth so interactive sign-in updates Windows WAM. Other home
state, prompts, history and approvals remain separate. No CaseIQ source or
credential contents are edited.

The native OAuth directory, including other MCP OAuth entries in the same
profile, is shared. Each profile is one selected TSE identity, not a way to
isolate simultaneous accounts. Account changes affect its other Sessions.
Existing private cache targets are never imported, moved or deleted; the new
profile may require one initial native sign-in. Existing Sessions connect on
their next explicit invocation, not by modifying a running CLI or replaying a
Prompt. Native expiry/revocation/MFA and reconnect requirements still apply.

Preparation records optional sanitized `oauthStorage` metadata in the hashed
binding: shared profile digest, or Session-local fallback with a fixed reason.
It is storage evidence, not authentication. Old or different-profile OAuth
verification is not reused as a green sign-in result. Real legacy directories,
unknown external links, unidentifiable profiles and filesystem/ACL failures
retain the original Session cache and surface a warning in the web panel and
launcher diagnostic output. Link replacement stages only new links; failure
restores the original link before falling back. Failed restoration stops the
invocation explicitly instead of running with unknown storage.

Offline tests cover cross-Work cold starts, Resume after launcher link repair,
separate owners/endpoints, concurrent preparation, legacy cache preservation
and replacement rollback. They do not prove live TSE/OAuth acceptance:

```powershell
npm test -- src\lib\caseiq-shared-oauth.test.ts src\lib\caseiq-runner.test.ts src\lib\caseiq-authentication-state.test.ts
```

SupportIQ sign-in uses the same Terminal transport with the optional
`authenticationOnly: true` marker. Validation requires an exact existing
session Resume, an empty Prompt, no automatic Prompt delivery and no
attachments. Its separate owned authentication operation, not a fabricated
running task, authorizes the existing `prepared`/`accept` handshake. The web
action creates no ordinary Run and never changes the session provider or
permission mode. Work/session starts remain reserved until matching native and
launcher results plus the exact stopped wrapper identity are confirmed.

Authentication-only windows print a high-contrast heading, the exact manual
command and TSE/exit instructions at preparation and again just before CLI
handoff. Normal Runs and ordinary Terminal sessions do not print that guide.
The Portal mirrors the real current/next action in a highlighted composer
notice outside history scrolling; completed/unknown idle Sessions do not leave
a permanent notice. Its copy, refresh, sign-in and exact-folder trust controls
reuse existing handlers and never submit a task Prompt or execute the command.

The optional `trustWorkFolder` flag is limited to authentication-only requests.
The web checkbox defaults on for this exact Work folder, remains revocable,
and preserves the user's explicit in-page choice across Runs of the same Work.
The client always sends its actual choice; omitted legacy wire fields still
default off. After acceptance and before native
spawn, it appends only the bound real Work directory to the private native
home's `config.json.trustedFolders`, preserving other keys. It never writes
global/parent folder trust or unrestricted permission flags. The web sign-in
action copies only the fixed `/mcp auth SupportIQ` command, with explicit
clipboard failure and manual-entry fallback.

The visible Work Conversation may invoke that same action automatically for
an explicit native SupportIQ OAuth request, needs-auth status or tool auth
rejection within the selected web Run's execution interval. Unknown state and
assistant advice do not qualify. The server derives a stable scoped UUID,
rechecks the native requirement under the existing Work/Session lock, and
persists that an attempt occurred. This suppresses duplicate tabs, refresh
loops and reopening due to events produced inside the authentication window.
Active/queued Runs defer opening rather than being cancelled or replayed.
Hidden pages, inactive sidebar panels, remote requests and archived Works do
not automatically open a Terminal. Manual sign-in remains available when safe.

Guided progress distinguishes accepted request, preparation, correlated native
spawn, strict OAuth observation and independently confirmed stop. A wrapper PID
alone never claims native startup. The UI shows completed/current steps and a
specific next manual action, respects reduced motion and expands a new flow
once without overriding subsequent disclosure choices. It neither executes
the copied command nor completes TSE login or closes the Terminal for the user.
Progress reads resolve ownership paths without repeatedly launching Git/CLI
probes; actual invocation preparation still checks current capabilities.

An authentication-only observer is staged in an attempt-specific directory
inside the bound native home's extensions. Its SDK extension interface joins
the existing foreground session; it creates no SDK session or model Prompt.
Verification requires an actual native MCP connection, live `tools/list` with
nonzero tools, and a second connected-state check. Private receipts contain the
request/run/attempt IDs, nonce, exact session, accepted prepared hash, timestamp,
status and tool count, never credentials. The host also validates the correlated
accepted journal/native-spawn and time bounds before reporting verification.
After the window stops, a retained receipt is historical verification, not
proof that the closed CLI still has an active MCP connection.

OAuth connection verification does not grant tool execution. Native prompt
runs carry optional `mcpToolApprovals` entries with an exact `serverName`,
`approvedTools` and an explicit `autoApprove` mode per MCP. Omitted wire fields
still grant nothing. The host computes effective grants from a saved
Work/session configuration: new configurations snapshot the current user's
Settings defaults (automatic initially enabled) and MCPs discovered in owned
CaseIQ sessions on that host. Per-session overrides remain independent and
existing saved manual/automatic choices are preserved. No Prompt or sign-in
receipt grants permission, and no arbitrary server can be supplied.

The shared pure `native-mcp-permissions.mjs` schemas are used by the web API,
private policy reader and native bridge. They reject wildcard/selector
injection and server names that collide with built-in permission kinds such as
`shell`, `read`, `write`, `url`, `memory` and `custom-tool`. All grants are rejected
for Terminal/auth-only invocations. The delegate retains the original launcher
rules, adds exact `--allow-tool server(tool)` or explicitly enabled
`--allow-tool server` rules, and hashes the effective arguments. Before
acceptance the host rechecks the canonical per-server snapshot and prepared
allow list. No unrestricted tools, path or URL flag is added.

Legacy v1/v2 policy files are read without rewriting them and retain their
manual baseline; explicit saves migrate to v3 while preserving every server's
existing grants. V3 stores the initial default snapshot separately from
explicit overrides, including empty manual opt-outs, so disabling automatic
approval cannot accidentally re-inherit an automatic default. Settings edits
affect only configurations initialized afterward. The old
SupportIQ-only API keeps its request/response contract and updates only its own
projection. New grouped controls use `caseiq/mcp-permissions`. Old
`approvedMcpTools`/`autoApproveSupportIq` bridge journals remain readable, but
mixing legacy and generic grant formats in one request is rejected.
Authentication and legacy Terminal launches do not inherit this web-only
consent. Existing accepted attempts retain their original snapshot.

New requests also freeze `disableNativeAutoUpdate: true`. Installation
version/help probes, the PowerShell launcher's intercepted version check, and
the actual native invocation all use the documented `--no-auto-update` flag.
The host verifies this capability and the delegate verifies the exact flag
count before accepting the effective arguments hash. This selects the
executable's bundled version rather than a newer downloaded CLI without
changing global installation. The observed version can change between Runs
without losing the original Session. Old journals remain readable; paths,
ownership and single-attempt argument/executable checks remain enforced.

The Conversation keeps sign-in and MCP controls in two compact, content-width
status disclosures, collapsed by default and not auto-expanded by polling.
Closed summaries are 28px high with transparent surfaces and existing theme
tokens, not two full-width white cards. They wrap on narrow screens, truncate
long status text with accessible full content, and keep status/error indicators.
Expanded content alone uses a theme surface. Actions stay transparent and
theme-aware. MCP configuration lives
in the Work Detail left panel, not the global navigation. Its Session selector
contains only this Work's sessions. Panel changes use Next-integrated native
history without unmounting the conversation or losing its draft. Legacy `/mcp`
links redirect to the exact Work/Session panel; old Run links resolve only
owned CaseIQ metadata rather than guessing the newest Session. Cross-Work
initial defaults remain in Settings. Index/default APIs
expose no prompts, native home paths or tool arguments.

Connection and live tool discovery alone are not OAuth proof. Authentication
now also requires a correlated passive native `mcp.oauth.probe` receipt; legacy
connection-only evidence is unverified. Only status, reason, HTTP status and
fixed error categories are stored, never response headers/bodies or tokens.
An authenticated probe observes an attached OAuth-origin token but does not
prove independent server validation, case access or future-Run success.
A later native SupportIQ authentication rejection invalidates older green
evidence. Folder trust remains explicit and exact-Work only; native JSONC
configuration is supported without relaxing ownership or trust guards.

Active web Runs also expose an owned, uncached `view=startup` metadata snapshot.
The Conversation renders it at the current Run's live chronological position,
after its request and recorded activity, not above older history. It is an
ephemeral Run-bound status rather than a fabricated native event. Pinned
history windows do not acquire current-Run status. Height changes follow the
live tail only while the user is already at the bottom; reading older messages
does not force a scroll. Raw output keeps its own current-Run status. Coordinator stages cover installation/session preparation,
the original launcher, accepted preparation and the correlated `native-spawn`.
Only the current invocation's native JSON assistant/tool activity advances to
processing; a wrapper PID, old history or launcher stdout cannot do so.
When the Conversation has displayed a recorded tool event from the current
startup attempt, its generic startup/working notice yields to Tools & run
details. Tool timestamps are compared with the owned snapshot's attempt start;
historical tools do not hide a new Follow Up or a later continuation attempt.
Stopping and observation errors remain visible. Raw output keeps its own
startup feedback.
Native spawn is not MCP readiness or authentication verification. Indeterminate
animation respects reduced motion, elapsed time is measured rather than
estimated, and the output action opens the existing current-Run raw log.
Fallback/continuation attempts reset their startup stages. Shared coordinator
state uses the existing `globalThis` approach and is removed with Run cleanup;
after coordinator loss or host mismatch the API reports unavailable evidence
rather than inferring that the Prompt was not sent. No protocol, permissions,
launcher arguments or request replay rules change.

The tool panel groups approvals by MCP. It exposes server/tool names from
owned history, default snapshots and saved choices, never customer output. Users may approve
or revoke each tool, atomically approve a visible pending snapshot for one MCP,
or opt into automatic approval of that MCP's current/future tools in this
Work/session. A server-wide grant does not promote other MCPs or same-named
tools in another server. Automatic mode includes write-capable tools; its
initial mode comes from the immutable Settings snapshot rather than a live
cross-Work shared flag. Disabling it retains that MCP's individual grants. No misleading
per-tool revoke action is exposed while its server-wide approval is active.
Active/queued/authenticated-in-progress sessions are
not modified, organization approval cannot be replaced, and denied calls or
old Prompts are never replayed. Other MCP, URL and file permissions stay
unchanged. An isolated local synthetic MCP test on the actual CLI confirmed
that an approved exact tool runs while an unapproved tool remains denied.
It made no customer queries and does not certify case entitlements.
An additional actual-CLI local-only test verified that SupportIQ-wide approval
does not grant another MCP and does not override an explicit native deny rule.
Resuming that same native session without automatic approval retained the exact
approved tool and denied the previously automatically allowed second tool.
The generic implementation was also verified with three local-only MCPs:
one exact-only, one automatically approved, and one unselected/denied. Removing
automatic approval on Resume retained exact grants on both selected MCPs and
did not authorize the unselected server. This is native CLI/tool validation,
not certification of real enterprise services or their OAuth sign-in.

UI state reads use monotonic request ordering: older polls cannot overwrite
a later saved decision or accepted sign-in reservation. Ambiguous save errors
remain visible until an explicit successful refresh; background polling does
not erase them. Loading and manual refresh have distinct busy feedback, and
historical verification timestamps include the date.

If a manually closed authentication window loses final receipts, the host may
recover its stopped state only from the exact wrapper creation identity, a
correlated accepted preparation/journal, and absence of its recorded native
PID, or proof that its current creation time is later than the recorded native
spawn and therefore belongs to a new process. A live PID without independently
proven original-process termination remains reserved. The host persists a stop
confirmation correlated with the request, nonce, session, accepted hash and
exact wrapper identity; later PID reuse cannot resurrect that reservation.
Subsequent checks revalidate that private stop receipt and its accepted
invocation before returning a closed state, without repeatedly starting a
Windows process-identity probe for an already proven stop.
Concurrent checks for the same operation share only the in-flight full
observation, including stopped-receipt persistence, preventing competing
Windows renames. They do not cache completed status or suppress write errors.
The unrelated new process is never stopped. Recovery proves process
termination, not OAuth authorization; drafts remain editable while sending is
gated until the reservation is released.
Normal native exit removes only the staged observer. Interrupted-window cleanup
also requires the accepted invocation, stopped process evidence, an exact
private-home directory and matching observer context. Unexpected files,
unverifiable ownership or live native PIDs are not recursively removed. OAuth
caches and other extensions are never cleanup targets.

The wrapper invokes the unmodified launcher with `-NoCasePicker -SkipUpdates`.
`SkipUpdates` does **not** prevent the launcher's own missing-dependency
installation or authentication behavior. Readiness probing must remain separate
and must not run this launcher.

At the real invocation boundary:

1. Capture the launcher's actual home, launch ID, case, directory, and arguments.
   Do not parse a terminal banner or search for the latest session.
2. Verify the frozen request, version, launcher hash, and explicit session.
   Unrestricted CLI permission flags are rejected.
3. Persist a `prepared` frame to the private journal. The coordinator must
   validate and persist the binding and acquire its lease before atomically
   writing `accept.json` with the matching IDs, nonce, and prepared hash.
4. Only then spawn the native executable with an argument array and `shell:false`.
   Prompt-mode stdout/stderr are frame payloads, never host control messages.
   Terminal mode inherits the actual console and does not parse or journal TUI output.
5. Write exactly one native process result and then a separate launcher result.
   Explicitly propagate the native/launcher exit code, including script errors.

The launcher may rename its temporary home to the explicit session UUID during
cleanup. After correlated request/accept/native/launcher results prove the
observed invocation and matching exits, the coordinator may record an immutable
private `finalHome`. It must be the exact same-parent session-UUID directory,
non-reparse, inside the owned native namespace, with nonempty history for that
session. The frozen `home` is never replaced. History and Resume use
`finalHome ?? home`; missing successful prompt history is an explicit error,
never a reason to choose the latest session or replay a prompt.

`cancel.json` uses the same correlation and a `user`, `timeout`, or `shutdown`
reason. An accepted cancellation stops only the owned native tree, allowing the
launcher to run its `finally`. The parent must still own the PowerShell process
to cancel preparation or escalate a failed stop. Windows termination is forced;
it does not prove telemetry was flushed. The existing CLI runner shares the
same owned-process stop implementation without changing its permission policy.

Request, invocation, journal, control, and result files are private runtime
data, not public Run artifacts. They may contain prompts, output, or paths.
Do not publish them through Run DTOs, SSE, a file browser, or automatic backups.
The eventual runtime owner must implement retention and bounded cleanup.
Prompt text can still appear in the inner native process command line.

## What this does not prove

`prepared` proves binding, **not** extension readiness. Exit zero proves a
process fact, **not** task completion. This layer never emits a successful Run.
If the native receipt is missing, `nativeExecutionObserved` is `null` (unknown),
not proof that no native process ran; never replay a prompt on that basis.

Real CaseIQ validation is a separate, explicitly authorized synthetic test
phase. It must prove extension/tool readiness before required diagnostics, both
reporting tools, native completion evidence, effective synthetic-only MCP
configuration, resume, shared-metadata concurrency, cancellation, and recovery.
The current CaseIQ `-Mock` flag is not a guarantee of SupportIQ isolation.

Basic live model execution, same-session Follow Up, Conversation, Pins and
history download have now passed using synthetic prompts and no model tool
calls; see the [recorded live test](caseiq-integration.md#真实网页复测). A marker
recall prompt received a model refusal and is not counted as correct recall.
SupportIQ still reported `needs-auth`, repository hooks were not trusted, and
telemetry running was not delivery proof. Those diagnostics/release gates are
not certified by the basic live test.

The subsequent native SupportIQ sign-in was completed by the user in the bound
synthetic session; the initial observer probes did not produce readiness or live
MCP/tool verification receipts. A later accepted-boundary observer passed real
same-session connection and live tool verification with 10 tools. This certifies
that synthetic session's native connection, not all case permissions or MCPs.
Automatic sign-in window closure remains **not implemented or certified**.
Stopping the owned verification process is test cleanup, not successful-auth
window automation. See [authentication and the explicit manual fallback](caseiq-integration.md#supportiq-认证与临时终端).

The explicit manual entry is now wired into the CaseIQ Conversation: **Sign in
to SupportIQ**, or the exact locally handled `/mcp auth SupportIQ` composer
command. It opens the bound original launcher/session; users authenticate and
exit the native window themselves. The page refreshes window ownership/exit
state and displays independently verified native connection/tool evidence when
available, with the last verification time. Verified or stopped operations
compact the full sign-in banner. Missing evidence remains explicitly unverified.
The model is never asked to execute the slash command. Automatic window closure
remains unsupported.

The WorkBoard adapter implements Runtime=CaseIQ with the existing web Run/SSE,
private history, Follow Up, Queue, cancellation and timeout paths. This is not a
universal Provider framework or proof of enterprise/MCP/telemetry readiness.
Legacy Terminal sessions are kept separate, not used as the default execution
path or an automatic failure fallback. No switch to ordinary CLI, SDK, widened
permissions or an unverified version is allowed.

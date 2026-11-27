param(
    [Parameter(Mandatory = $true)][string]$RequestFile,
    [string]$NodeExecutable
)

$ErrorActionPreference = 'Continue'
# Prefer this host's built-ins without discarding the user's custom module paths.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
$exitCode = 1
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$delegate = Join-Path $PSScriptRoot 'caseiq-native-delegate.mjs'
$terminalLaunchFile = $null

function Show-CaseIQAuthenticationInstructions {
    Write-Host ''
    Write-Host '  ACTION REQUIRED: SUPPORTIQ SIGN-IN ONLY  ' -ForegroundColor Black -BackgroundColor Yellow
    Write-Host '  Wait for the Copilot prompt, then run:'
    Write-Host '  /mcp auth SupportIQ  ' -ForegroundColor Black -BackgroundColor Cyan
    Write-Host '  1. Run the command above in this Terminal, not in Work Board.'
    Write-Host '  2. Choose your TSE account on the official sign-in page.'
    Write-Host '  3. After OAuth is checked in Work Board, exit Copilot.'
    Write-Host '     Close this Terminal and return to Work Board.'
    Write-Host '  DO NOT SEND TASK PROMPTS IN THIS WINDOW.  ' -ForegroundColor Black -BackgroundColor Yellow
    Write-Host ''
}

function Save-CaseIQTerminalState {
    param([string]$File, [Nullable[int]]$ExitStatus)
    if (-not $File) { return }
    $state = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
    $state | Add-Member -NotePropertyName wrapperPid -NotePropertyValue $PID -Force
    $startTime = ([Diagnostics.Process]::GetCurrentProcess()).StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
    $state | Add-Member -NotePropertyName wrapperStartTime -NotePropertyValue $startTime -Force
    if ($null -ne $ExitStatus) {
        $state | Add-Member -NotePropertyName exitCode -NotePropertyValue ([int]$ExitStatus) -Force
        $context = $global:WorkBoardCaseIQBridgeContext
        if ($context -and $context.Request.authenticationOnly) {
            $state | Add-Member -NotePropertyName nativeInvoked -NotePropertyValue ([bool]$context.Invoked) -Force
        }
    }
    $temporary = "$File.$PID.tmp"
    [IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $backup = "$File.bak"
    [IO.File]::Replace($temporary, $File, $backup)
    Remove-Item -LiteralPath $backup -Force -ErrorAction Stop
}

function Save-CaseIQPromptWrapper {
    param([string]$Directory, $Request)
    $ErrorActionPreference = 'Stop'
    $startTime = ([Diagnostics.Process]::GetCurrentProcess()).StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
    $state = @{
        protocolVersion = $Request.protocolVersion
        requestId = $Request.requestId
        runId = $Request.runId
        attemptId = $Request.attemptId
        nonce = $Request.nonce
        pid = $PID
        startTime = $startTime
    }
    $file = Join-Path $Directory 'prompt-wrapper.json'
    $temporary = "$file.$PID.tmp"
    [IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Compress), $utf8)
    [IO.File]::Move($temporary, $file)
}

function Test-CaseIQCriticalScriptError {
    foreach ($record in $global:Error) {
        if ($record.Exception -is [Microsoft.PowerShell.Commands.WriteErrorException] -or
            $record.Exception -is [System.Management.Automation.MethodInvocationException]) { return $true }
    }
    return $false
}

function Save-CaseIQAuthenticationError {
    param([System.Management.Automation.ErrorRecord]$Record)
    $context = $global:WorkBoardCaseIQBridgeContext
    if (-not $context -or -not $context.Request.authenticationOnly) { return }
    $detail = @{
        exceptionType = $Record.Exception.GetType().FullName
        errorId = $Record.FullyQualifiedErrorId
        script = [IO.Path]::GetFileName($Record.InvocationInfo.ScriptName)
        line = $Record.InvocationInfo.ScriptLineNumber
        stack = $Record.ScriptStackTrace
    }
    if ($Record.FullyQualifiedErrorId -like 'TypeNotFound*') {
        $detail.missingType = [regex]::Match($Record.Exception.Message, '\[([A-Za-z0-9_.+,`]+)\]').Groups[1].Value
    }
    [IO.File]::WriteAllText((Join-Path $context.Directory 'script-error.json'), ($detail | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}

try {
    if (-not $NodeExecutable) {
        $NodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    }
    $NodeExecutable = (Get-Item -LiteralPath $NodeExecutable -ErrorAction Stop).FullName
    $RequestFile = (Get-Item -LiteralPath $RequestFile -ErrorAction Stop).FullName
    & $NodeExecutable $delegate validate $RequestFile
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $directory = [IO.Path]::GetDirectoryName($RequestFile)
    $validatedFile = Join-Path $directory 'validated-request.json'
    $request = Get-Content -LiteralPath $validatedFile -Raw -Encoding UTF8 | ConvertFrom-Json
    # CaseIQ enables StrictMode for the bridge calls; omitted optional flags need explicit defaults.
    foreach ($flag in @('authenticationOnly', 'disableNativeAutoUpdate')) {
        if ($null -eq $request.PSObject.Properties[$flag]) {
            $request | Add-Member -NotePropertyName $flag -NotePropertyValue $false
        }
    }
    $terminalLaunchFile = $request.terminalLaunchFile
    Save-CaseIQTerminalState -File $terminalLaunchFile
    if ($request.PSObject.Properties['trackPromptWrapper']) {
        Save-CaseIQPromptWrapper -Directory $directory -Request $request
        # A restarted server can seal an attempt before this wrapper reaches its launcher.
        if (Test-Path -LiteralPath (Join-Path $directory 'cancel.json') -ErrorAction Stop) {
            & $NodeExecutable $delegate finalize $validatedFile '130' '0'
            exit $LASTEXITCODE
        }
    }
    $global:WorkBoardCaseIQBridgeContext = [pscustomobject]@{
        Request = $request
        RequestFile = $validatedFile
        Directory = $directory
        NodeExecutable = $NodeExecutable
        Delegate = $delegate
        ObservedVersion = ''
        Invoked = $false
        ScriptError = $false
    }

    # CaseIQ runs in another script scope; this context belongs only to this process.
    function global:copilot {
        $context = $global:WorkBoardCaseIQBridgeContext
        if ($context.Request.mode -eq 'terminal' -and (Test-CaseIQCriticalScriptError)) {
            $context.ScriptError = $true
        }
        $nativeArguments = @($args | ForEach-Object { [string]$_ })
        $prefix = @($context.Request.testExecutableArgs)
        if ($prefix.Count -gt 0 -and $env:NODE_ENV -ne 'test') {
            throw 'Executable argument overrides are test-only.'
        }
        if ($nativeArguments.Count -eq 1 -and $nativeArguments[0] -eq '--version') {
            $versionArguments = @($nativeArguments)
            if ($context.Request.disableNativeAutoUpdate) {
                $versionArguments = @('--no-auto-update', '--version')
            }
            $versionOutput = @(& $context.Request.nativeExecutable @prefix @versionArguments 2>&1)
            $nativeExitCode = $LASTEXITCODE
            $match = [regex]::Match(($versionOutput -join "`n"), 'GitHub Copilot CLI (\d+\.\d+\.\d+)')
            if ($nativeExitCode -ne 0 -or -not $match.Success -or
                $match.Groups[1].Value -ne $context.Request.nativeVersion) {
                throw 'The native Copilot version does not match the frozen request.'
            }
            $context.ObservedVersion = $match.Groups[1].Value
            $versionOutput | Write-Output
            $global:LASTEXITCODE = $nativeExitCode
            return
        }
        if ($context.ScriptError) {
            throw 'The launcher reported a script error before native execution.'
        }
        if (-not $context.ObservedVersion -or $context.Invoked) {
            throw 'Unexpected or repeated native Copilot invocation.'
        }
        if ($context.Request.disableNativeAutoUpdate) {
            $nativeArguments = @('--no-auto-update') + $nativeArguments
        }
        $context.Invoked = $true
        $caseNumber = if ($env:CASEIQ_CASE_NUMBER) { $env:CASEIQ_CASE_NUMBER } else { $null }
        $instructions = if ($env:COPILOT_CUSTOM_INSTRUCTIONS_DIRS) {
            @($env:COPILOT_CUSTOM_INSTRUCTIONS_DIRS -split [regex]::Escape([string][IO.Path]::PathSeparator))
        } else { @() }
        $invocation = @{
            requestFile = $context.RequestFile
            nativeArguments = @($nativeArguments)
            home = $env:COPILOT_HOME
            launchId = $env:CASEIQ_LAUNCH_ID
            caseNumber = $caseNumber
            workingDirectory = (Get-Location).Path
            instructionDirectories = @($instructions)
            observedVersion = $context.ObservedVersion
        }
        $invocationFile = Join-Path $context.Directory 'invocation.json'
        $content = $invocation | ConvertTo-Json -Depth 6
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($content)
        $stream = [IO.File]::Open($invocationFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        if ($context.Request.authenticationOnly) { Show-CaseIQAuthenticationInstructions }
        & $context.NodeExecutable $context.Delegate execute $invocationFile
        $global:LASTEXITCODE = $LASTEXITCODE
    }

    $extra = @()
    if ($request.mode -eq 'prompt') {
        $extra = @('-p', $request.prompt, '--output-format', 'json', '--stream', 'on')
    } elseif ($request.sendPrompt) {
        $extra = @('-i', $request.prompt)
    }
    if ($request.PSObject.Properties['sharedInputDirectory'] -and $request.sharedInputDirectory -and -not $request.authenticationOnly) {
        $extra += @('--add-dir', [string]$request.sharedInputDirectory)
    }
    if ($request.resume) { $extra += "--resume=$($request.sessionId)" }
    else { $extra += "--session-id=$($request.sessionId)" }
    foreach ($attachment in @($request.attachments)) { $extra += @('--attachment', $attachment) }
    foreach ($field in @(@('model', '--model'), @('agent', '--agent'), @('contextTier', '--context'), @('reasoningEffort', '--effort'))) {
        $value = $request.($field[0])
        if ($value) { $extra += @($field[1], $value) }
    }
    $parameters = @{ NoCasePicker = $true; SkipUpdates = $true; ExtraArgs = $extra }
    if (@($request.packs).Count -gt 0) { $parameters.Packs = @($request.packs) }
    if ($request.caseNumber) { $parameters.CaseNumber = $request.caseNumber }

    Set-Location -LiteralPath $request.workingDirectory -ErrorAction Stop
    if ($request.authenticationOnly) {
        Show-CaseIQAuthenticationInstructions
    }
    try {
        if ($request.mode -eq 'terminal') {
            $global:Error.Clear()
            & $request.launcherPath @parameters
            if (Test-CaseIQCriticalScriptError) { $global:WorkBoardCaseIQBridgeContext.ScriptError = $true }
        } else {
            & $request.launcherPath @parameters 2>&1 | ForEach-Object {
                if ($_ -is [System.Management.Automation.ErrorRecord]) {
                    if ($_.FullyQualifiedErrorId -notlike 'NativeCommandError*') {
                        $global:WorkBoardCaseIQBridgeContext.ScriptError = $true
                    }
                    [Console]::Error.WriteLine($_.ToString())
                } else {
                    [Console]::Out.WriteLine([string]$_)
                }
            }
        }
        $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 1 }
    }
    catch {
        $global:WorkBoardCaseIQBridgeContext.ScriptError = $true
        Save-CaseIQAuthenticationError -Record $_
        [Console]::Error.WriteLine($_.ToString())
        $exitCode = 1
    }
    & $NodeExecutable $delegate finalize $validatedFile ([string]$exitCode) $(if ($global:WorkBoardCaseIQBridgeContext.ScriptError) { '1' } else { '0' })
    $exitCode = $LASTEXITCODE
}
catch {
    Save-CaseIQAuthenticationError -Record $_
    [Console]::Error.WriteLine("[CaseIQ bridge] " + $_.ToString())
    $exitCode = 1
}
finally {
    try { Save-CaseIQTerminalState -File $terminalLaunchFile -ExitStatus $exitCode }
    catch {
        [Console]::Error.WriteLine("[CaseIQ bridge] Terminal exit status could not be recorded: " + $_.ToString())
        $exitCode = 1
    }
    if (Test-Path Function:\global:copilot) { Remove-Item Function:\global:copilot }
    Remove-Variable -Name WorkBoardCaseIQBridgeContext -Scope Global -ErrorAction SilentlyContinue
}

exit $exitCode

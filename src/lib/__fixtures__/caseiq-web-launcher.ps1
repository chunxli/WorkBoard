param(
    [switch]$NoCasePicker,
    [switch]$SkipUpdates,
    [string[]]$Packs,
    [string]$CaseNumber,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ExtraArgs
)

Set-StrictMode -Version Latest

if ($env:NODE_ENV -ne 'test') { throw 'Synthetic CaseIQ launcher is test-only.' }
$null = copilot --version
$fixtureFile = $global:WorkBoardCaseIQBridgeContext.Request.testExecutableArgs[1]
$fixture = Get-Content -LiteralPath $fixtureFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($fixture.mode -eq 'authentication-only') {
    $null = Get-Item -LiteralPath (Join-Path $PSScriptRoot 'synthetic-missing-optional-file') -ErrorAction SilentlyContinue
}
$renaming = $fixture.mode -in @('rename-after-run', 'rename-wait')
$env:COPILOT_HOME = if ($renaming -and $global:WorkBoardCaseIQBridgeContext.Request.resume) {
    Join-Path $env:CASEIQ_HOME $global:WorkBoardCaseIQBridgeContext.Request.sessionId
} else { Join-Path $env:CASEIQ_HOME 'copilot' }
$null = New-Item -ItemType Directory -Path $env:COPILOT_HOME -Force
$originalOAuth = Join-Path $env:CASEIQ_HOME 'shared\mcp-oauth-config'
$null = New-Item -ItemType Directory -Path $originalOAuth -Force
$oauthLink = Join-Path $env:COPILOT_HOME 'mcp-oauth-config'
$existingOAuth = Get-Item -LiteralPath $oauthLink -Force -ErrorAction SilentlyContinue
if ($existingOAuth -and ($existingOAuth.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    [IO.Directory]::Delete($oauthLink)
}
if (-not (Test-Path -LiteralPath $oauthLink)) {
    $null = New-Item -ItemType Junction -Path $oauthLink -Target $originalOAuth -ErrorAction Stop
}
$mcpConfiguration = Join-Path $env:COPILOT_HOME 'mcp-config-channel.json'
$supportIqProperty = $fixture.PSObject.Properties['supportIqUrl']
$supportIqUrl = if ($null -ne $supportIqProperty -and $supportIqProperty.Value) {
    $supportIqProperty.Value
} else { 'https://supportiq.invalid/mcp' }
[IO.File]::WriteAllText($mcpConfiguration, (@{ mcpServers = @{ SupportIQ = @{
    type = 'http'; url = $supportIqUrl; tools = @('synthetic_tool')
} } } | ConvertTo-Json -Depth 6))
$env:CASEIQ_LAUNCH_ID = 'synthetic-web-launch'
$root = $PSScriptRoot
$longDirectory = Join-Path $env:CASEIQ_HOME ('generated\' + ('long-path-' + ('x' * 100)) + '\pack-instructions')
$null = New-Item -ItemType Directory -Path $longDirectory -Force
$longFile = Join-Path $longDirectory 'platform--customer-content-protected-material.instructions.md'
[IO.File]::WriteAllText($longFile, 'Synthetic long-path instructions')
if (-not (Test-Path -LiteralPath $longFile)) { throw 'Synthetic generated instructions are unavailable.' }
$flags = @(
    '--plugin-dir', (Join-Path $root 'telemetry'),
    '--plugin-dir', (Join-Path $root 'runtime'),
    '--plugin-dir', (Join-Path $root 'support-packs\platform'),
    '--additional-mcp-config', "@$mcpConfiguration",
    '--allow-tool', 'custom-tool(report_session_complete)'
)
if ($ExtraArgs -notcontains '--model') { $flags += @('--model', 'synthetic-default') }
Write-Output 'Synthetic CaseIQ preparation; no customer services or model are used.'
copilot @flags @ExtraArgs
$exitCode = $LASTEXITCODE
if ($renaming -and -not $global:WorkBoardCaseIQBridgeContext.Request.resume) {
    $finalHome = Join-Path ([IO.Path]::GetDirectoryName($env:COPILOT_HOME)) $global:WorkBoardCaseIQBridgeContext.Request.sessionId
    [IO.Directory]::Move($env:COPILOT_HOME, $finalHome)
}
exit $exitCode

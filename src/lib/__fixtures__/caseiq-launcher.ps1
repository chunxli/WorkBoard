param(
    [string[]]$Packs,
    [string]$CaseNumber,
    [switch]$NoCasePicker,
    [switch]$SkipUpdates,
    [string[]]$ExtraArgs
)

Set-StrictMode -Version Latest

if ($env:NODE_ENV -ne 'test') { throw 'Synthetic launcher is test-only.' }
if (-not $NoCasePicker -or -not $SkipUpdates) { throw 'Missing launcher policy flags.' }

[IO.File]::WriteAllText($env:WORKBOARD_BRIDGE_TEST_ENTERED, 'entered')
Write-Host 'Synthetic launcher log; this is not a native protocol frame.'
if ($env:WORKBOARD_BRIDGE_TEST_LAUNCHER -eq 'change-launcher') {
    [IO.File]::AppendAllText($PSCommandPath, "`n# synthetic change")
}
if ($env:WORKBOARD_BRIDGE_TEST_LAUNCHER -eq 'prepare-hang') { Start-Sleep -Seconds 60 }
if ($env:WORKBOARD_BRIDGE_TEST_LAUNCHER -eq 'prepare-throw') { throw 'Synthetic setup failure.' }
if ($env:WORKBOARD_BRIDGE_TEST_LAUNCHER -eq 'prepare-error') { Write-Error 'Synthetic non-terminating setup failure.' }

$version = @(copilot --version)
if ($version.Count -eq 0) { throw 'Synthetic native version was not returned.' }
New-Item -ItemType Directory -Path $env:WORKBOARD_BRIDGE_TEST_HOME -Force | Out-Null
$env:COPILOT_HOME = $env:WORKBOARD_BRIDGE_TEST_HOME
$env:CASEIQ_LAUNCH_ID = 'synthetic-launch'
$env:CASEIQ_CASE_NUMBER = if ($CaseNumber) { $CaseNumber } else { $null }
$env:COPILOT_CUSTOM_INSTRUCTIONS_DIRS = $env:WORKBOARD_BRIDGE_TEST_PACK

$flags = @(
    '--plugin-dir', $env:WORKBOARD_BRIDGE_TEST_PACK,
    '--allow-tool', 'custom-tool(report_skill_complete)',
    '--allow-tool', 'custom-tool(report_session_complete)'
) + @($ExtraArgs)
if ($env:WORKBOARD_BRIDGE_TEST_LAUNCHER -eq 'allow-all') { $flags += '--allow-all-tools' }
if ($env:WORKBOARD_BRIDGE_TEST_LAUNCHER -eq 'unknown-option') { $flags += '--unknown-option' }
if ($env:WORKBOARD_BRIDGE_TEST_LAUNCHER -eq 'wrong-session') {
    $flags = @($flags | Where-Object { $_ -notlike '--session-id=*' })
    $flags += '--session-id=00000000-0000-4000-8000-000000000001'
}

$code = 0
try {
    if ($env:WORKBOARD_BRIDGE_TEST_LAUNCHER -ne 'no-execution') {
        & copilot @flags
        $code = $LASTEXITCODE
        if ($env:WORKBOARD_BRIDGE_TEST_LAUNCHER -eq 'repeat') {
            & copilot @flags
            $code = $LASTEXITCODE
        }
    }
}
finally {
    [IO.File]::WriteAllText($env:WORKBOARD_BRIDGE_TEST_FINISHED, 'finished')
    if ($env:WORKBOARD_BRIDGE_TEST_LAUNCHER -eq 'finalize-error') {
        Write-Error 'Synthetic finalization failure.'
    }
}

$global:LASTEXITCODE = $code

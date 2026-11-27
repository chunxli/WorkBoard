param(
    [Parameter(Mandatory = $true)]
    [string]$LaunchFile
)

$ErrorActionPreference = "Stop"
$launch = Get-Content -LiteralPath $LaunchFile -Raw -Encoding UTF8 | ConvertFrom-Json
$exitCode = 1

function Save-LaunchState {
    $temporaryPath = "$LaunchFile.tmp"
    $content = $launch | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($temporaryPath, $content, [System.Text.UTF8Encoding]::new($false))
    $backupPath = "$LaunchFile.bak"
    [System.IO.File]::Replace($temporaryPath, $LaunchFile, $backupPath)
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
}

$launch | Add-Member -NotePropertyName wrapperPid -NotePropertyValue $PID -Force
Save-LaunchState

try {
    Set-Location -LiteralPath $launch.workingDirectory
    $allowedEnvKeys = @(
        "COPILOT_ENTRA_ONEAUTH",
        "COPILOT_ENTRA_ONEAUTH_SCOPE_BINDING_MODE",
        "COPILOT_ENTRA_DISABLE_ONEAUTH",
        "COPILOT_CUSTOM_INSTRUCTIONS_DIRS"
    )
    if ($launch.PSObject.Properties['environment'] -and $null -ne $launch.environment) {
        foreach ($key in $allowedEnvKeys) {
            if (-not $launch.environment.PSObject.Properties[$key]) { continue }
            $value = $launch.environment.$key
            if ($null -eq $value -or [string]$value -eq '') {
                Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
            }
            else {
                Set-Item -LiteralPath "Env:$key" -Value ([string]$value)
            }
        }
    }
    [string[]]$copilotArgs = @()
    if ($null -ne $launch.PSObject.Properties['copilotArgs'] -and $null -ne $launch.copilotArgs) {
        foreach ($arg in @($launch.copilotArgs)) {
            $copilotArgs += [string]$arg
        }
    }
    else {
        $copilotArgs += "--resume=$($launch.sessionId)"
    }
    if ($launch.PSObject.Properties['sharedInputDirectory'] -and $launch.sharedInputDirectory) {
        $copilotArgs += @("--add-dir", [string]$launch.sharedInputDirectory)
    }
    if ($null -ne $launch.PSObject.Properties['extraArgs'] -and $null -ne $launch.extraArgs) {
        foreach ($arg in @($launch.extraArgs)) {
            $copilotArgs += [string]$arg
        }
    }
    $env:SUPPORTIQ_INTERACTIVE_AUTH = "1"
    & copilot @copilotArgs
    $exitCode = $LASTEXITCODE
}
catch {
    Write-Error $_
}
finally {
    $launch | Add-Member -NotePropertyName exitCode -NotePropertyValue $exitCode -Force
    Save-LaunchState
}

exit $exitCode
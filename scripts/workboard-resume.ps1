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
    $copilotArgs = if ($null -ne $launch.copilotArgs) {
        @($launch.copilotArgs | ForEach-Object { [string]$_ })
    }
    else {
        @("--resume=$($launch.sessionId)")
    }
    & copilot @($copilotArgs)
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
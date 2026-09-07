param(
    [Parameter(Mandatory = $true)]
    [string]$LaunchFile
)

$ErrorActionPreference = "Stop"
$launch = Get-Content -LiteralPath $LaunchFile -Raw -Encoding UTF8 | ConvertFrom-Json
$exitCode = 1
$synchronized = $false

try {
    Set-Location -LiteralPath $launch.workingDirectory
    $copilotArgs = if ($null -ne $launch.copilotArgs) {
        @($launch.copilotArgs | ForEach-Object { [string]$_ })
    }
    else {
        @("--resume=$($launch.sessionId)")
    }
    & copilot @copilotArgs
    $exitCode = $LASTEXITCODE
}
catch {
    Write-Error $_
}
finally {
    $launch | Add-Member -NotePropertyName exitCode -NotePropertyValue $exitCode -Force
    $launch | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $LaunchFile -Encoding UTF8
    try {
        $headers = @{ Authorization = "Bearer $($launch.callbackToken)" }
        $body = @{ exitCode = $exitCode } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $launch.callbackUrl -Method Post -Headers $headers -ContentType "application/json" -Body $body | Out-Null
        $synchronized = $true
    }
    catch {
        Write-Warning "Work Board could not synchronize this session automatically. Use Sync session from the run page."
    }
    if ($synchronized) {
        Remove-Item -LiteralPath $LaunchFile -Force -ErrorAction SilentlyContinue
    }
}

exit $exitCode
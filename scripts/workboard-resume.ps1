param(
    [Parameter(Mandatory = $true)]
    [string]$LaunchFile
)

$ErrorActionPreference = "Stop"
$launch = Get-Content -LiteralPath $LaunchFile -Raw | ConvertFrom-Json
$exitCode = 1

try {
    Set-Location -LiteralPath $launch.workingDirectory
    & copilot "--resume=$($launch.sessionId)"
    $exitCode = $LASTEXITCODE
}
catch {
    Write-Error $_
}
finally {
    try {
        $headers = @{ Authorization = "Bearer $($launch.callbackToken)" }
        $body = @{ exitCode = $exitCode } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $launch.callbackUrl -Method Post -Headers $headers -ContentType "application/json" -Body $body | Out-Null
    }
    catch {
        Write-Warning "Work Board could not synchronize this session automatically. Use Sync session from the run page."
    }
    Remove-Item -LiteralPath $LaunchFile -Force -ErrorAction SilentlyContinue
}

exit $exitCode
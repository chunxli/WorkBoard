param(
    [ValidateSet("Send", "Prepare", "Inspect", "Remove")]
    [string]$Action = "Send"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$mutex = $null
$locked = $false

function Assert-OwnedPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    $homePath = [Environment]::GetFolderPath("UserProfile")
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, "S-1-5-18", "S-1-5-32-544")
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    while ($current) {
        if ([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) {
            if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing a redirected notification identity path."
            }
            $acl = if ([IO.Directory]::Exists($current)) { [IO.Directory]::GetAccessControl($current) } else { [IO.File]::GetAccessControl($current) }
            if ($allowed -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) {
                throw "Notification identity path has a different owner."
            }
            foreach ($rule in $acl.Access) {
                if ($rule.AccessControlType -eq "Allow" -and
                    ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
                    ($rule.FileSystemRights -band $writeMask) -ne 0 -and
                    $allowed -notcontains $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value) {
                    throw "Notification identity path is writable by another principal."
                }
            }
        }
        if ($current -eq $homePath) { break }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Write-OwnedState([string]$File, [string]$Text) {
    Assert-OwnedPath $File
    $temporary = "$File.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
        } finally { $stream.Dispose() }
        Assert-OwnedPath $File
        if ([IO.File]::Exists($File)) { [IO.File]::Replace($temporary, $File, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $File) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function File-Hash([string]$File) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($File)
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

try {
    $inputReader = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8, $true)
    try { $payload = $inputReader.ReadToEnd() | ConvertFrom-Json }
    finally { $inputReader.Dispose() }
    $appId = [string]$payload.appId
    if ($appId -notmatch '^WorkBoard\.(Desktop|Test)\.[a-f0-9]{12,32}$') { throw "Invalid Work Board notification identity." }
    $root = [IO.Path]::GetFullPath([string]$payload.root)
    $identityDirectory = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "WorkBoard\Notifications\$appId"
    $stateFile = Join-Path $identityDirectory "owner.json"
    $registryPath = "Software\Classes\AppUserModelId\$appId"
    $png = Join-Path $root "public\workboard-notification.png"
    $ico = Join-Path $root "public\workboard-notification.ico"
    $shortcutDirectory = Join-Path ([Environment]::GetFolderPath("Programs")) $(if ($appId.StartsWith("WorkBoard.Test.")) { "Work Board Notification Tests" } else { "Work Board" })
    $shortcut = Join-Path $shortcutDirectory "Work Board - $($appId.Split('.')[-1]).lnk"
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = New-Object Threading.Mutex($false, "Local\WorkBoard.Notifications.$sid.$appId")
    try { $locked = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw "Another notification identity operation is still running. Retry after it finishes." }

    Assert-OwnedPath $identityDirectory
    Assert-OwnedPath $stateFile
    Assert-OwnedPath $shortcut
    $previousState = if ([IO.File]::Exists($stateFile)) { [IO.File]::ReadAllText($stateFile) } else { $null }
    $state = if ($previousState) { $previousState | ConvertFrom-Json } else { $null }
    if ($state -and ($state.version -ne 1 -or $state.appId -ne $appId -or $state.root -ne $root -or $state.owner -ne $sid)) {
        throw "Notification identity metadata belongs to another installation."
    }
    if ([IO.Directory]::Exists($identityDirectory) -and -not $state) {
        throw "An unowned notification identity directory already exists."
    }
    if ([IO.File]::Exists($shortcut) -and (-not $state -or (File-Hash $shortcut) -ne $state.shortcutHash)) {
        throw "The notification shortcut is unowned or was changed outside Work Board."
    }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath)
    $registered = $null -ne $key
    if ($key) {
        try {
            if (-not $state -or $key.GetValue("WorkBoardRoot") -ne $root -or
                $key.GetValue("DisplayName") -ne "Work Board" -or $key.GetValue("IconUri") -ne $png) {
                throw "The Windows notification identity is unowned or was changed outside Work Board."
            }
            if ($key.SubKeyCount -ne 0) { throw "Unexpected child keys in the notification identity; refusing to modify it." }
        } finally { $key.Dispose() }
    }

    if ($Action -eq "Inspect") {
        @{ installed = ($registered -and [IO.File]::Exists($shortcut)); appId = $appId; directory = $identityDirectory; shortcut = $shortcut; icon = $png } | ConvertTo-Json -Compress
        exit 0
    }
    if ($Action -eq "Remove") {
        if ($state) {
            $files = @([IO.Directory]::GetFileSystemEntries($identityDirectory))
            if ($files.Count -ne 1 -or $files[0] -ne $stateFile) { throw "Unexpected files in notification identity; cleanup left them untouched." }
            [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
            [Windows.UI.Notifications.ToastNotificationManager]::History.Clear($appId)
            if ($registered) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($registryPath) }
            if ($appId.StartsWith("WorkBoard.Test.")) {
                $settingsPath = "Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\$appId"
                $settingsKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($settingsPath)
                if ($settingsKey) {
                    try { $hasChildren = $settingsKey.SubKeyCount -ne 0 }
                    finally { $settingsKey.Dispose() }
                    if ($hasChildren) { throw "Unexpected child keys in the test notification settings; left them untouched." }
                    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($settingsPath)
                }
            }
            if ([IO.File]::Exists($shortcut)) { [IO.File]::Delete($shortcut) }
            if ($appId.StartsWith("WorkBoard.Test.") -and [IO.Directory]::Exists($shortcutDirectory) -and [IO.Directory]::GetFileSystemEntries($shortcutDirectory).Length -eq 0) {
                [IO.Directory]::Delete($shortcutDirectory)
            }
            [IO.File]::Delete($stateFile)
            [IO.Directory]::Delete($identityDirectory)
        }
        @{ removed = $true; appId = $appId } | ConvertTo-Json -Compress
        exit 0
    }

    $url = $null
    if (-not [Uri]::TryCreate([string]$payload.url, [UriKind]::Absolute, [ref]$url) -or
        $url.Scheme -notin @("http", "https") -or $url.UserInfo) { throw "Notification activation requires a trusted HTTP(S) URL." }
    if (-not [IO.File]::Exists($png) -or -not [IO.File]::Exists($ico)) { throw "Work Board notification icons are missing. Restore the public notification assets." }
    foreach ($field in @("title", "message", "details")) {
        $text = [string]$payload.$field
        if ($text.Length -gt 1000 -or $text -match '[\x00-\x1f\x7f]') { throw "Invalid notification text." }
    }
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.UI.Notifications.ToastNotifier, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.UI.Notifications.NotificationSetting, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null

    $newIdentity = -not $registered -or -not [IO.File]::Exists($shortcut)
    if ($newIdentity) {
        $shortcutCreated = $false
        $createdDirectory = -not [IO.Directory]::Exists($identityDirectory)
        $installedShortcutHash = $null
        $stateText = $null
        try {
            if (-not $state) {
                [IO.Directory]::CreateDirectory($identityDirectory) > $null
                Assert-OwnedPath $identityDirectory
            }
            if (-not [IO.File]::Exists($shortcut)) {
                [IO.Directory]::CreateDirectory($shortcutDirectory) > $null
                Assert-OwnedPath $shortcutDirectory
                Add-Type -Path (Join-Path $root "scripts\notification-shortcut.cs")
                $hash = [Security.Cryptography.SHA256]::Create()
                try { $activatorBytes = $hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($appId))[0..15] }
                finally { $hash.Dispose() }
                $activator = [Guid]::new([byte[]]$activatorBytes)
                $temporary = "$shortcut.$([Guid]::NewGuid().ToString('N')).tmp"
                try {
                    [WorkBoardNotificationShortcut]::Create($temporary, (Join-Path $env:SystemRoot "explorer.exe"), "`"$($url.GetLeftPart([UriPartial]::Authority))/work`"", $appId, $ico, $activator.ToString())
                    Assert-OwnedPath $shortcut
                    [IO.File]::Move($temporary, $shortcut)
                    $shortcutCreated = $true
                    $installedShortcutHash = File-Hash $shortcut
                } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
            }
            $stateText = @{ version = 1; appId = $appId; root = $root; owner = $sid; shortcutHash = (File-Hash $shortcut) } | ConvertTo-Json -Compress
            Write-OwnedState $stateFile $stateText
            $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
            try {
                $key.SetValue("WorkBoardRoot", $root)
                $key.SetValue("DisplayName", "Work Board")
                $key.SetValue("IconUri", $png)
                $key.SetValue("IconBackgroundColor", "transparent")
                $key.SetValue("ShowInSettings", 1, [Microsoft.Win32.RegistryValueKind]::DWord)
            } finally { $key.Dispose() }
        } catch {
            $registrationError = $_.Exception.Message
            $cleanupErrors = New-Object 'System.Collections.Generic.List[string]'
            try {
                $partialKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath)
                if ($partialKey) {
                    try { $owned = -not $registered -and $partialKey.GetValue("WorkBoardRoot") -eq $root }
                    finally { $partialKey.Dispose() }
                    if ($owned) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($registryPath) }
                }
            } catch { $cleanupErrors.Add($_.Exception.Message) }
            try {
                if ($shortcutCreated -and [IO.File]::Exists($shortcut)) {
                    if ((File-Hash $shortcut) -ne $installedShortcutHash) { throw "The new shortcut changed during rollback; left it untouched." }
                    [IO.File]::Delete($shortcut)
                }
            } catch { $cleanupErrors.Add($_.Exception.Message) }
            try {
                $currentText = if ([IO.File]::Exists($stateFile)) { [IO.File]::ReadAllText($stateFile) } else { $null }
                if ($previousState -and $currentText -ne $previousState) {
                    if ($currentText -and $currentText -ne $stateText) { throw "Notification metadata changed during rollback; left it untouched." }
                    Write-OwnedState $stateFile $previousState
                } elseif (-not $previousState -and $currentText) {
                    if ($currentText -ne $stateText) { throw "Unowned metadata appeared during rollback; left it untouched." }
                    [IO.File]::Delete($stateFile)
                }
                if ($createdDirectory -and [IO.Directory]::Exists($identityDirectory) -and [IO.Directory]::GetFileSystemEntries($identityDirectory).Length -eq 0) {
                    [IO.Directory]::Delete($identityDirectory)
                }
            } catch { $cleanupErrors.Add($_.Exception.Message) }
            if ($cleanupErrors.Count -gt 0) { $registrationError += "; identity cleanup failed: " + ($cleanupErrors -join "; ") }
            throw $registrationError
        }
    }

    $document = New-Object Windows.Data.Xml.Dom.XmlDocument
    $toast = $document.CreateElement("toast")
    $toast.SetAttribute("activationType", "protocol")
    $toast.SetAttribute("launch", $url.AbsoluteUri)
    $toast.SetAttribute("duration", "short")
    $document.AppendChild($toast) > $null
    $visual = $document.CreateElement("visual")
    $toast.AppendChild($visual) > $null
    $binding = $document.CreateElement("binding")
    $binding.SetAttribute("template", "ToastGeneric")
    $visual.AppendChild($binding) > $null
    foreach ($field in @("title", "message", "details")) {
        if (-not [string]::IsNullOrWhiteSpace([string]$payload.$field)) {
            $node = $document.CreateElement("text")
            $node.InnerText = [string]$payload.$field
            $node.SetAttribute("hint-maxLines", $(if ($field -eq "message") { "2" } else { "1" }))
            $binding.AppendChild($node) > $null
        }
    }
    $image = $document.CreateElement("image")
    $image.SetAttribute("placement", "appLogoOverride")
    $image.SetAttribute("src", ([Uri]$png).AbsoluteUri)
    $binding.AppendChild($image) > $null
    if ($Action -eq "Prepare") {
        @{ prepared = $true; appId = $appId; xml = $document.GetXml(); shortcut = $shortcut } | ConvertTo-Json -Compress
        exit 0
    }
    $sender = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
    try {
        $setting = $sender.GetType().GetProperty("Setting").GetValue($sender, $null)
        if ($setting -ne [Windows.UI.Notifications.NotificationSetting]::Enabled) {
            throw "Windows notifications are disabled for Work Board or this user. Check Windows notification settings."
        }
    } catch {
        # Windows has no per-app policy record before an identity's first submission.
        if ($_.Exception.GetBaseException().HResult -ne -2147023728) { throw }
    }
    $notification = [Windows.UI.Notifications.ToastNotification]::new($document)
    $notification.Group = "WorkBoard"
    $notification.Tag = [Guid]::NewGuid().ToString("N").Substring(0, 16)
    $sender.Show($notification)
    @{ submitted = $true; appId = $appId; tag = $notification.Tag; icon = $png } | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine("Windows notification operation failed at line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)")
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}

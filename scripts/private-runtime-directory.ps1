param([Parameter(Mandatory = $true)][string]$Directory)

$ErrorActionPreference = 'Stop'
# Node may inherit PowerShell 7 module paths while this process runs Windows PowerShell.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
$directoryInfo = Get-Item -LiteralPath $Directory
if (-not $directoryInfo.PSIsContainer) { throw 'Private runtime storage must be a directory.' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
# Preserve the SACL: only the owner and DACL belong to this operation.
$sections = [Security.AccessControl.AccessControlSections]'Access, Owner'
$acl = [IO.Directory]::GetAccessControl($directoryInfo.FullName, $sections)
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in $acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
    $acl.RemoveAccessRuleSpecific($rule)
}
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($identity in @($sid, $system)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity, 'FullControl', $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($directoryInfo.FullName, $acl)

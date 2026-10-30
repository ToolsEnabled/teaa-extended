param()
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Refuse { throw [InvalidOperationException]::new('Windows Fleet package ownership or ACL is not supported.') }
function Inspect-Path([string]$Path, [string]$UserSid, [bool]$Ancestor) {
  $attributes = [IO.File]::GetAttributes($Path)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse }
  $directory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $acl = if ($directory) { [IO.Directory]::GetAccessControl($Path, $sections) } else { [IO.File]::GetAccessControl($Path, $sections) }
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $raw.DiscretionaryAcl -or $null -eq $raw.Owner) { Refuse }
  $trusted = @($UserSid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if ($trusted -notcontains $raw.Owner.Value) { Refuse }
  $writeRights = 0x10000000L -bor 0x40000000L -bor 0x000D0156L
  $replacementRights = 0x10000000L -bor 0x40000000L -bor 0x000D0150L
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace.GetType() -ne [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -notin @([Security.AccessControl.AceQualifier]::AccessAllowed,[Security.AccessControl.AceQualifier]::AccessDenied)) { Refuse }
    $inheritOnly = ([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0
    if (!$inheritOnly -and $ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $trusted -notcontains $ace.SecurityIdentifier.Value) {
      $mask = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$ace.AccessMask), 0)
      if ($Ancestor) {
        if (($mask -band $replacementRights) -ne 0) { Refuse }
      } elseif (($mask -band $writeRights) -ne 0) { Refuse }
    }
  }
}
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.path -isnot [string] -or !$request.path -or @($request.PSObject.Properties.Name | Where-Object { $_ -cne 'path' }).Count) { Refuse }
  $root = [IO.Path]::GetFullPath($request.path)
  $drive = [IO.Path]::GetPathRoot($root)
  $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $chain = New-Object 'System.Collections.Generic.List[string]'
  $cursor = $root
  while ($cursor) { $chain.Add($cursor); if ($cursor -eq $drive) { break }; $cursor = [IO.Path]::GetDirectoryName($cursor) }
  if ($chain[$chain.Count - 1] -ne $drive) { Refuse }
  for ($i=$chain.Count-1; $i -ge 0; $i--) {
    # Only real parents use the ancestor replacement-rights allowance. The
    # package root itself must be free of all untrusted write/replace rights.
    Inspect-Path $chain[$i] $userSid ($i -gt 0)
  }
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($root)
  while ($pending.Count) {
    $directory = $pending.Pop()
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      Inspect-Path $entry $userSid $false
      if (([IO.File]::GetAttributes($entry) -band [IO.FileAttributes]::Directory) -ne 0) { $pending.Push($entry) }
    }
  }
  [Console]::WriteLine('{"ok":true}')
} catch {
  [Console]::WriteLine('{"ok":false,"code":"WINDOWS_FLEET_PACKAGE_ACL"}')
  exit 1
}

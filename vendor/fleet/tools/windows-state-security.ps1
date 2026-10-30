param([switch]$Library, [switch]$Server)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Derived from ToolsEngine installer/windows-security.ps1 (MIT), source ba551c70.
# This helper accepts paths, never capability contents or executable text.
# It creates only missing directories; existing security descriptors are read only.
function Refuse-Security([string]$reason) { throw [InvalidOperationException]::new($reason) }
function Assert-PlainLocalInput([string]$value) {
  if (!$value) { Refuse-Security 'Use an absolute local drive path.' }
  $localSpelling = $value.Replace('/', '\')
  if (!$localSpelling -or $localSpelling -notmatch '^[A-Za-z]:\\' -or $localSpelling.Substring(2).Contains(':')) { Refuse-Security 'Use an absolute local drive path.' }
  foreach ($part in $localSpelling.Substring(3).Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
    if ($part -in @('.','..') -or $part -match '[<>"|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { Refuse-Security 'The directory name is not supported on Windows.' }
  }
}
function Plain-DirectoryPath([string]$value) {
  Assert-PlainLocalInput $value
  $full = [IO.Path]::GetFullPath($value)
  $current = [IO.Path]::GetPathRoot($full)
  $null = [ToolsEngineInstallerVolume]::InspectDirectory($current)
  Assert-AncestorSecurity (Read-DirectorySecurity $current)
  foreach ($part in $full.Substring($current.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
    if ($part -match '[<>"|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { Refuse-Security 'The directory name is not supported on Windows.' }
    $current = [IO.Path]::Combine($current, $part)
    if ([IO.File]::Exists($current)) { Refuse-Security 'A directory path names a file.' }
    if ([IO.Directory]::Exists($current)) {
      if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse-Security 'Directory paths must not traverse reparse points or junctions.' }
      $null = [ToolsEngineInstallerVolume]::InspectDirectory($current)
      Assert-AncestorSecurity (Read-DirectorySecurity $current)
    }
  }
  return $full
}
function Assert-AncestorSecurity($security) {
  # Measured native C:\ owner: NT SERVICE\TrustedInstaller. This exception
  # applies only to existing ancestor ownership, never private-entry owners or
  # allowed DACL writers; all replacement/control checks still apply.
  $ancestorOwnerTrusted = $security.ownerTrusted -or $security.ownerSid -ceq 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  if (!$ancestorOwnerTrusted -or !$security.ancestorControlRestricted) { Refuse-Security 'An ancestor can be replaced or its ACL changed by another account. Choose a private local path.' }
}
function Assess-RawSecurityDescriptor($raw, [string]$userSidValue) {
  if ($null -eq $raw.DiscretionaryAcl -or $null -eq $raw.Owner) { Refuse-Security 'A null DACL or missing owner is not supported.' }
  $ownerSid = $raw.Owner.Value
  $trusted = @($userSidValue, 'S-1-5-18', 'S-1-5-32-544')
  $private = $true
  $writeRestricted = $true
  $ancestorControlRestricted = $true
  # Generic masks can appear in a raw ACE before the filesystem maps them.
  $writeRights = 0x10000000L -bor 0x40000000L -bor 0x000D0156L
  $replacementRights = 0x10000000L -bor 0x40000000L -bor 0x000D0150L
  foreach ($ace in $raw.DiscretionaryAcl) {
    # Do not drop grants that the managed GetAccessRules view cannot represent.
    # Object, callback/conditional and unknown ACEs require a separate audited
    # interpretation; until then they refuse, even when apparently restrictive.
    if ($ace.GetType() -ne [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -notin @([Security.AccessControl.AceQualifier]::AccessAllowed,[Security.AccessControl.AceQualifier]::AccessDenied)) { Refuse-Security 'The DACL contains an unsupported access rule.' }
    if ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $trusted -notcontains $ace.SecurityIdentifier.Value) {
      $mask = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$ace.AccessMask), 0)
      if ($mask -ne 0) { $private = $false }
      if (($mask -band $writeRights) -ne 0) { $writeRestricted = $false }
      # An inherit-only ACE grants nothing on this existing ancestor. Its
      # actual children are checked in turn; new private roots discard it.
      # Windows PowerShell 5.1 cannot reliably bitwise-combine byte-backed
      # enums. Preserve the numeric flag policy with explicit Int32 operands.
      $inheritOnly = ([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0
      if (!$inheritOnly -and ($mask -band $replacementRights) -ne 0) { $ancestorControlRestricted = $false }
    }
  }
  return @{ ownerSid=$ownerSid; userSid=$userSidValue; ownerTrusted=($trusted -contains $ownerSid); ownedByUser=($ownerSid -eq $userSidValue); private=$private; writeRestricted=$writeRestricted; ancestorControlRestricted=$ancestorControlRestricted; protected=([int]$raw.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0 }
}
function Read-DirectorySecurity([string]$directory) {
  if (![IO.Directory]::Exists($directory)) { Refuse-Security 'The directory does not exist.' }
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $acl = [IO.Directory]::GetAccessControl($directory, $sections)
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
  return Assess-RawSecurityDescriptor $raw $script:userSid.Value
}
function New-PrivateDirectory([string]$directory) {
  if ([IO.Directory]::Exists($directory)) { return }
  $parent = [IO.Path]::GetDirectoryName($directory)
  if (!$parent -or $parent -eq $directory) { Refuse-Security 'A directory parent is required.' }
  if (![IO.Directory]::Exists($parent)) { New-PrivateDirectory $parent }
  $parentSecurity = Read-DirectorySecurity $parent
  if (!$parentSecurity.ownerTrusted -or !$parentSecurity.writeRestricted) { Refuse-Security 'The parent can be changed by another account. Choose a private install location.' }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($script:userSid)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sidValue in @($script:userSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $null = $acl.AddAccessRule($rule)
  }
  # Windows PowerShell 5.1/.NET Framework creates the directory with its DACL,
  # before any program, workspace or installer-record bytes are written.
  $null = [IO.Directory]::CreateDirectory($directory, $acl)
}
function Assert-PrivateEntry($result) {
  # An elevated Windows token creates files owned by Administrators even
  # beneath a user-owned root. SYSTEM and Administrators already have full
  # control in the private DACL; accepting those owners adds no principal.
  # The selected state root still requires ownedByUser below.
  if (!$result.ownerTrusted -or !$result.private -or !$result.writeRestricted) { Refuse-Security 'State must have a trusted owner and a private DACL.' }
}
function Read-PrivateFile([string]$file) {
  if (![IO.File]::Exists($file) -or ([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse-Security 'State files must be regular files without reparse points.' }
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $acl = [IO.File]::GetAccessControl($file, $sections)
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
  $result = Assess-RawSecurityDescriptor $raw $script:userSid.Value
  Assert-PrivateEntry $result
  return $result
}
function Assert-PrivateTree([string]$directory) {
  Assert-PrivateEntry (Read-DirectorySecurity $directory)
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
    $attributes = [IO.File]::GetAttributes($entry)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse-Security 'State must not contain reparse points.' }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { Assert-PrivateTree $entry }
    else { $null = Read-PrivateFile $entry }
  }
}

if ($Library) { return }

function Invoke-PathRequest([string]$inputText) {
try {
  if ($inputText.Length -gt 32768) { Refuse-Security 'The path request is too large.' }
  $request = $inputText | ConvertFrom-Json
  if ($request.operation -cnotin @('inspect','create','file','tree','ancestors','publish') -or $request.path -isnot [string] -or @($request.PSObject.Properties.Name | Where-Object { $_ -cnotin @('operation','path','source') }).Count) { Refuse-Security 'The path request is invalid.' }
  $script:userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if (-not ('ToolsEngineInstallerVolume' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'windows-volume.cs') }
  if ($request.operation -ceq 'publish') {
    Assert-PlainLocalInput $request.path
    Assert-PlainLocalInput $request.source
    $parent = Plain-DirectoryPath ([IO.Path]::GetDirectoryName($request.path))
    $security = Read-DirectorySecurity $parent
    Assert-PrivateEntry $security
    if (!$security.ownedByUser -or [IO.Path]::GetDirectoryName($request.source) -cne $parent -or [IO.Path]::GetFileName($request.path) -cne 'host-mode.json' -or [IO.Path]::GetFileName($request.source) -cnotmatch '^\.host-mode-[a-f0-9]{24}\.tmp$') { Refuse-Security 'Only a private host configuration may be published.' }
    $null = Read-PrivateFile $request.source
    if ([IO.File]::Exists($request.path)) { $null = Read-PrivateFile $request.path }
    [ToolsEngineInstallerVolume]::PublishFile($request.source,$request.path)
    [Console]::WriteLine('{"ok":true}')
    return
  }
  if ($request.PSObject.Properties.Name -contains 'source') { Refuse-Security 'The path request is invalid.' }
  $isFile = $request.operation -ceq 'file'
  if ($isFile) {
    Assert-PlainLocalInput $request.path
    $directory = Plain-DirectoryPath ([IO.Path]::GetDirectoryName($request.path))
    $result = Read-PrivateFile $request.path
  } else {
    $directory = Plain-DirectoryPath $request.path
    if ($request.operation -ceq 'create') { New-PrivateDirectory $directory }
    $null = Plain-DirectoryPath $directory
    if ($request.operation -ceq 'ancestors') {
      [Console]::WriteLine('{"ok":true}')
      return
    }
    $result = Read-DirectorySecurity $directory
    Assert-PrivateEntry $result
    if (!$result.ownedByUser) { Refuse-Security 'The selected state root must belong to this account.' }
    if ($request.operation -ceq 'tree') { Assert-PrivateTree $directory }
  }
  $volume = [ToolsEngineInstallerVolume]::InspectDirectory($directory)
  $result.fileSystem = $volume.FileSystem
  $result.fixedDrive = $volume.FixedDrive
  $result.ok = $true
  [Console]::WriteLine(($result | ConvertTo-Json -Compress))
} catch {
  # Exception/provider messages can contain paths or environment data. Only our
  # own bounded reasons may be displayed by the Node installer.
  $reason = 'Windows directory security could not be verified.'
  if ($_.Exception -is [InvalidOperationException] -and $_.Exception.Message.Length -le 160) { $reason = $_.Exception.Message }
  [Console]::WriteLine((@{ok=$false;code='WINDOWS_DIRECTORY_SECURITY';reason=$reason} | ConvertTo-Json -Compress))
  if (!$Server) { $script:requestFailed = $true }
}
}

if ($Server) {
  while ($null -ne ($line = [Console]::In.ReadLine())) { Invoke-PathRequest $line }
} else {
  $script:requestFailed = $false
  Invoke-PathRequest ([Console]::In.ReadToEnd())
  if ($script:requestFailed) { exit 1 }
}

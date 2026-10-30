param([Parameter(Mandatory=$true)][string]$Root)
# Two host-audit records only; no provider credentials or desktop vault access.
# Same-user readability/tampering is explicitly not a security boundary.
. (Join-Path $PSScriptRoot 'windows-state-security.ps1') -Library
function Refuse-Audit([string]$code) { throw [InvalidOperationException]::new($code) }
function Check-File([string]$file) {
  if (![IO.File]::Exists($file)) {
    if (Test-Path -LiteralPath $file) { Refuse-Audit 'SECRET_VAULT_PATH_UNSAFE' }
    return $false
  }
  $null = Read-PrivateFile $file
  $item = Get-Item -Force -LiteralPath $file
  if ($item.Length -gt 32768 -or $item.LinkType -or @(Get-Item -LiteralPath $file -Stream * | Where-Object { $_.Stream -cne ':$DATA' }).Count) { Refuse-Audit 'SECRET_VAULT_PATH_UNSAFE' }
  return $true
}
function Read-Record([string]$name) {
  $file = Join-Path $script:store $name
  if (!(Check-File $file)) { return $null }
  return [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)
}
function Write-Record([string]$name,[string]$value) {
  $file = Join-Path $script:store $name
  $null = Check-File $file
  $temporary = Join-Path $script:store ('.write-' + [Guid]::NewGuid().ToString('N'))
  $bytes = [Text.Encoding]::UTF8.GetBytes($value)
  if (!$bytes.Length -or $bytes.Length -gt 32768) { Refuse-Audit 'SECRET_INPUT_INVALID' }
  $stream = $null
  try {
    # Private parent is proved before CreateNew; it grants only user/SYSTEM/admin.
    $stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $null = Read-PrivateFile $temporary
    $stream.Write($bytes,0,$bytes.Length)
    $stream.Flush($true)
    $stream.Dispose(); $stream = $null
    $null = Check-File $temporary
    [ToolsEngineInstallerVolume]::PublishFile($temporary,$file)
    $null = Check-File $file
  } finally {
    if ($stream) { $stream.Dispose() }
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}
$lock = $null
try {
  $script:userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-volume.cs')
  $raw = [Console]::In.ReadToEnd()
  if ($raw.Length -gt 33792) { Refuse-Audit 'SECRET_INPUT_INVALID' }
  $request = $raw | ConvertFrom-Json
  $rootPath = Plain-DirectoryPath $Root
  $rootSecurity = Read-DirectorySecurity $rootPath
  Assert-PrivateEntry $rootSecurity
  if (!$rootSecurity.ownedByUser) { Refuse-Audit 'SECRET_VAULT_PATH_UNSAFE' }
  $script:store = Join-Path $rootPath 'audit-keys'
  $null = Plain-DirectoryPath $script:store
  if (![IO.Directory]::Exists($script:store)) {
    if ($request.operation -cin @('select','getOrCreate','setMonotonic')) { New-PrivateDirectory $script:store }
    elseif ($request.operation -ceq 'peek') { [Console]::WriteLine('{"ok":true,"value":null}'); exit 0 }
    else { Refuse-Audit 'SECRET_NOT_CONFIGURED' }
  }
  $storeSecurity = Read-DirectorySecurity $script:store
  Assert-PrivateEntry $storeSecurity
  if (!$storeSecurity.ownedByUser) { Refuse-Audit 'SECRET_VAULT_PATH_UNSAFE' }
  # Existing entries are checked, never repaired, including an unsafe lock.
  Assert-PrivateTree $script:store
  $lockPath = Join-Path $script:store 'store.lock'
  $null = Check-File $lockPath
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  while (!$lock) {
    try { $lock = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
    catch [IO.IOException] { if ($deadline.ElapsedMilliseconds -ge 2000) { Refuse-Audit 'SECRET_VAULT_LOCK_TIMEOUT' }; Start-Sleep -Milliseconds 10 }
  }
  $null = Read-PrivateFile $lockPath
  if ($lock.Length -ne 0) { Refuse-Audit 'SECRET_VAULT_PATH_UNSAFE' }
  $selected = Read-Record 'store.json'
  if ($null -ne $selected) {
    $selection = $selected | ConvertFrom-Json
    if (@($selection.PSObject.Properties.Name).Count -ne 1 -or $selection.kind -cnotin @('private-file','os-keyring')) { Refuse-Audit 'SECRET_VAULT_UNREADABLE' }
    $selected = $selection.kind
  }
  $value = $null
  switch -CaseSensitive ($request.operation) {
    'peek' { $value = $selected }
    'select' {
      if ($request.kind -cne 'private-file') { Refuse-Audit 'SECRET_INPUT_INVALID' }
      if ($null -eq $selected) { Write-Record 'store.json' '{"kind":"private-file"}'; $selected = 'private-file' }
      $value = $selected
    }
    default {
      $key = $request.key
      if ($key -ceq 'toolsenabled_audit_signing_key_v1') { $name = 'signing-private-key.pem' }
      elseif ($key -ceq 'toolsenabled_audit_head_v1') { $name = 'head.json' }
      else { Refuse-Audit 'SECRET_ACCESS_DENIED' }
      if ($null -ne $selected -and $selected -cne 'private-file') { Refuse-Audit 'SECRET_ACCESS_DENIED' }
      $existing = Read-Record $name
      if ($request.operation -ceq 'get') {
        if ($null -eq $existing) { Refuse-Audit 'SECRET_NOT_CONFIGURED' }
        $value = $existing
      } else {
        if ($selected -cne 'private-file') { Refuse-Audit 'SECRET_ACCESS_DENIED' }
        if ($request.value -isnot [string] -or !$request.value -or [Text.Encoding]::UTF8.GetByteCount($request.value) -gt 32768) { Refuse-Audit 'SECRET_INPUT_INVALID' }
        if ($request.operation -ceq 'getOrCreate' -and $name -ceq 'signing-private-key.pem') {
          if ($null -eq $existing) { Write-Record $name $request.value; $existing = $request.value }
          $value = $existing
        } elseif ($request.operation -ceq 'setMonotonic' -and $name -ceq 'head.json') {
          $sequence = $request.sequence
          if ($sequence -isnot [long] -and $sequence -isnot [int]) { Refuse-Audit 'SECRET_INPUT_INVALID' }
          if ($sequence -lt 0 -or $sequence -gt 9007199254740991 -or ($request.value | ConvertFrom-Json).sequence -ne $sequence) { Refuse-Audit 'SECRET_INPUT_INVALID' }
          if ($null -ne $existing) {
            $prior = ($existing | ConvertFrom-Json).sequence
            if (($prior -isnot [long] -and $prior -isnot [int]) -or $prior -lt 0) { Refuse-Audit 'SECRET_VAULT_UNREADABLE' }
            if ($sequence -lt $prior -or ($sequence -eq $prior -and $existing -cne $request.value)) { Refuse-Audit 'SECRET_MONOTONIC_CONFLICT' }
          }
          if ($null -eq $existing -or $sequence -ne $prior) { Write-Record $name $request.value }
        } else { Refuse-Audit 'SECRET_ACCESS_DENIED' }
      }
    }
  }
  [Console]::WriteLine((@{ok=$true;value=$value} | ConvertTo-Json -Compress -Depth 8))
} catch {
  $code = 'SECRET_VAULT_PATH_UNSAFE'
  if ($_.Exception -is [InvalidOperationException] -and $_.Exception.Message -cmatch '^SECRET_[A-Z_]+$') { $code = $_.Exception.Message }
  [Console]::WriteLine((@{ok=$false;code=$code} | ConvertTo-Json -Compress))
} finally { if ($lock) { $lock.Dispose() } }

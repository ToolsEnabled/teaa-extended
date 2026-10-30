param([Parameter(Mandatory=$true)][int]$StartPid,
      [Parameter(Mandatory=$true)][long]$ChildStartTicks)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FleetWindowsArguments {
  [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern IntPtr CommandLineToArgvW(string command,out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  public static string[] Split(string command) {
    int count;
    IntPtr buffer=CommandLineToArgvW(command,out count);
    if(buffer==IntPtr.Zero || count<1 || count>4096) throw new InvalidOperationException();
    try {
      string[] result=new string[count];
      for(int i=0;i<count;i++)result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer,i*IntPtr.Size));
      return result;
    } finally { LocalFree(buffer); }
  }
}
'@
try {
  if ($StartPid -lt 2 -or $ChildStartTicks -lt 1) { throw 'Invalid process identity' }
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $cursor = $StartPid
  $childStarted = $ChildStartTicks
  $rows = @()
  $seen = @{}
  for ($step=0; $step -lt 6 -and $cursor -gt 1; $step++) {
    if ($seen.ContainsKey($cursor)) { throw 'Process cycle' }
    $seen[$cursor] = $true
    $entry = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor"
    if (!$entry -or !$entry.CommandLine -or $entry.CommandLine.Length -gt 65536) { break }
    $sid = Invoke-CimMethod -InputObject $entry -MethodName GetOwnerSid
    if ($sid.ReturnValue -ne 0 -or $sid.Sid -cne $owner) { break }
    $started = $entry.CreationDate.ToUniversalTime().Ticks
    if ($started -gt $childStarted) { break }
    $rows += @{pid=$cursor;parent=[int]$entry.ParentProcessId;argv=[FleetWindowsArguments]::Split($entry.CommandLine)}
    $childStarted = $started
    $cursor = [int]$entry.ParentProcessId
  }
  [Console]::WriteLine((ConvertTo-Json -InputObject @($rows) -Depth 5 -Compress))
} catch {
  # Command lines may contain task context. Never print them on failure.
  [Console]::WriteLine('[]')
  exit 1
}

param([Parameter(Mandatory=$true)][int]$StartPid, [switch]$Descendants, [switch]$Single)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FleetWindowsArguments {
  [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern IntPtr CommandLineToArgvW(string command,out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("advapi32.dll",SetLastError=true)]
  static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  // Read the same token user as Win32_Process.GetOwnerSid, but bind it to the
  // queried creation time through a live process handle. Never trust PID alone.
  public static bool OwnedGeneration(int pid,long started,string owner) {
    IntPtr process=OpenProcess(0x1000,false,pid), token=IntPtr.Zero;
    if(process==IntPtr.Zero) return false;
    try {
      long created,exited,kernel,user;
      if(!GetProcessTimes(process,out created,out exited,out kernel,out user)) return false;
      // Win32_Process CreationDate has microsecond precision; FILETIME has
      // 100ns precision. Compare at the query's precision, without rounding up.
      long ticks=DateTime.FromFileTimeUtc(created).Ticks;
      if(ticks-ticks%10!=started || !OpenProcessToken(process,8,out token)) return false;
      using(var identity=new System.Security.Principal.WindowsIdentity(token)) {
        return identity.User!=null && String.Equals(identity.User.Value,owner,StringComparison.Ordinal);
      }
    } finally {
      if(token!=IntPtr.Zero) CloseHandle(token);
      CloseHandle(process);
    }
  }
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
  if ($StartPid -lt 2 -or ($Single -and $Descendants)) { throw 'Invalid process identity' }
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $rows = @(); $seen = @{}; $table = @{}
  # One fresh query per observation, not a CIM round trip for every ancestor.
  # Only owner- and generation-verified rows below can leave this helper.
  $query = @{ClassName='Win32_Process';Property=@('ProcessId','ParentProcessId','CommandLine','ExecutablePath','CreationDate')}
  if ($Single) { $query.Filter = "ProcessId=$StartPid" }
  foreach ($entry in @(Get-CimInstance @query)) {
    $table[[int]$entry.ProcessId] = $entry
  }
  $queue = New-Object 'Collections.Generic.Queue[object]'
  $queue.Enqueue(@{id=$StartPid;bound=[long]::MaxValue})
  while ($queue.Count -gt 0 -and $rows.Count -lt 8192) {
    $next = $queue.Dequeue(); $cursor = [int]$next.id
    if ($cursor -lt 2 -or $seen.ContainsKey($cursor)) { continue }
    $seen[$cursor] = $true
    $entry = $table[$cursor]
    if (!$entry -or !$entry.CommandLine -or $entry.CommandLine.Length -gt 65536) { continue }
    $started = $entry.CreationDate.ToUniversalTime().Ticks
    if (![FleetWindowsArguments]::OwnedGeneration($cursor,$started,$owner)) { continue }
    # A recycled parent PID must never connect unrelated generations.
    if ((!$Descendants -and $started -gt $next.bound) -or ($Descendants -and $cursor -ne $StartPid -and $started -lt $next.bound)) { continue }
    $rows += @{pid=$cursor;ppid=[int]$entry.ParentProcessId;argv=[FleetWindowsArguments]::Split($entry.CommandLine);executable=[string]$entry.ExecutablePath;startTime=('win32:'+$started)}
    if ($Descendants) {
      foreach ($child in $table.Values) {
        if ([int]$child.ParentProcessId -eq $cursor) { $queue.Enqueue(@{id=[int]$child.ProcessId;bound=$started}) }
      }
    } elseif (!$Single -and $rows.Count -lt 16) { $queue.Enqueue(@{id=[int]$entry.ParentProcessId;bound=$started}) }
  }
  [Console]::WriteLine((ConvertTo-Json -InputObject @($rows) -Depth 5 -Compress))
} catch {
  # Never include command lines or task context in errors.
  [Console]::WriteLine('[]'); exit 1
}

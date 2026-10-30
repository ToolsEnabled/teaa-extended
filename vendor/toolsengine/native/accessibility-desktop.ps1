$ErrorActionPreference = 'Stop'
$script:desktopFailureCode = $null
$script:desktopFailureHResult = $null
# Only helper-owned stage codes and numeric HRESULTs may cross the boundary.
# Never serialize an application exception, title, path, or captured content.
function New-SafeFocusFailure {
  param([AllowNull()][string]$Code, [AllowNull()][object]$HResult)
  $stages = @{
    FOCUS_WINDOW_REVALIDATION = 'The confirmed window changed during focus validation.'
    FOCUS_RAISE_FAILED = 'The confirmed window could not be raised without activation.'
    FOCUS_RESTORE = 'The confirmed window could not be restored.'
    FOCUS_NATIVE_REQUEST = 'The Windows foreground request failed.'
    FOCUS_NATIVE_NOT_FOREGROUND = 'Windows did not foreground the confirmed window. Use background UI Automation actions where offered, or the existing-browser extension for browser tasks.'
    FOCUS_FOREGROUND_CHANGED = 'Foreground changed during activation.'
    FOCUS_ROOT_UNAVAILABLE = 'The confirmed window provider was unavailable.'
    FOCUS_UIA_ROOT_CALL = 'The window accessibility provider rejected its focus request.'
    FOCUS_UIA_ROOT_NOT_FOREGROUND = 'The window provider returned, but Windows did not foreground the confirmed window.'
    FOCUS_UIA_FIELD_CALL = 'The confirmed field provider rejected its focus request.'
    FOCUS_FIELD_MISMATCH = 'The confirmed field did not receive focus.'
  }
  # Case-sensitive allowlisting prevents application-originated strings.
  if ($Code -cnotin @($stages.Keys)) { return $null }
  $failure = @{ ok=$false; refusal=$true; code=$Code; error=('[' + $Code + '] ' + $stages[$Code] + ' No text was sent.') }
  if ($Code -cin @('FOCUS_UIA_ROOT_CALL','FOCUS_UIA_ROOT_NOT_FOREGROUND')) {
    $failure.error += ' Capture the confirmed window again; if unobscured, choose a neutral point from the new image with desktop.pointer click, then verify focus.'
  }
  if ($Code -cin @('FOCUS_UIA_ROOT_CALL','FOCUS_UIA_FIELD_CALL') -and $HResult -is [int]) {
    $hex = [BitConverter]::ToUInt32([BitConverter]::GetBytes($HResult), 0).ToString('X8')
    $failure.hresult = '0x' + $hex
    $failure.error += ' HRESULT ' + $failure.hresult + '.'
  }
  return $failure
}

function New-SafeDesktopFailure {
  param([AllowNull()][string]$Code)

  if ($Code -cnotin @('WINDOW_OUTSIDE_LEFT_HALF', 'POINT_OUTSIDE_LEFT_HALF', 'WINDOW_DID_NOT_FIT_LEFT_HALF', 'WINDOW_GEOMETRY_CHANGED', 'WINDOW_MOVED_DURING_CAPTURE')) { return $null }
  $effectiveCode = 'DESKTOP_REQUEST_REFUSED'
  $message = 'Windows could not safely complete this request. Inspect before retrying.'
  switch -CaseSensitive ($Code) {
    'WINDOW_OUTSIDE_LEFT_HALF' {
      $effectiveCode = $Code
      $message = 'The window is outside the left half. Use desktop.act with kind focus on this window, then desktop.capture. Choose coordinates from the new image before trying again. No pointer input was sent.'
      break
    }
    'POINT_OUTSIDE_LEFT_HALF' {
      $effectiveCode = $Code
      $message = 'The selected point is outside the left half. Use desktop.act with kind focus on this window, then desktop.capture. Choose coordinates from the new image before trying again. No pointer input was sent.'
      break
    }
    'WINDOW_DID_NOT_FIT_LEFT_HALF' {
      $effectiveCode = $Code
      $message = 'The window could not fit inside the left half. Inspect its position before trying again. No keyboard or pointer input was sent.'
      break
    }
    'WINDOW_GEOMETRY_CHANGED' {
      $effectiveCode = $Code
      $message = 'The window moved or resized after capture. Capture this window again and choose coordinates from the new image. No pointer input was sent.'
      break
    }
    'WINDOW_MOVED_DURING_CAPTURE' {
      $effectiveCode = $Code
      $message = 'The window moved or resized during capture. Capture this window again before choosing coordinates.'
      break
    }
  }
  return @{ ok = $false; refusal = $true; code = $effectiveCode; error = ('[' + $effectiveCode + '] ' + $message) }
}

[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  # A refusal is a sentence written in this file. Only those reach the
  # assistant. Anything Windows or an application raises is replaced with a
  # generic sentence in the catch block, because it can carry window content.
  $script:refusal = $null
  function Refuse([string]$reason) { $script:refusal = $reason; throw $reason }
  $requestLine = [Console]::ReadLine()
  if (!$requestLine -or $requestLine.Length -gt 24000) { Refuse 'Invalid bounded desktop request.' }
  $request = $requestLine | ConvertFrom-Json
  if ($request.command -notin @('windows', 'inspect', 'action', 'capture', 'position-left', 'pointer')) { Refuse 'Unsupported desktop request.' }
  if ($null -ne $request.includeText -and $request.includeText -isnot [bool]) { Refuse 'Invalid text inspection option.' }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName UIAutomationClientSideProviders
  $null = [System.Windows.Automation.AutomationElement]::RootElement
  [System.Windows.Automation.ClientSettings]::RegisterClientSideProviders(
    [UIAutomationClientsideProviders.UIAutomationClientSideProviders]::ClientSideProviderDescriptionTable)
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
public class AccessibilityRefusal : Exception { public AccessibilityRefusal(string reason) : base(reason) {} }
public static class AccessibilityNative {
  public delegate bool EnumCallback(IntPtr handle, IntPtr unused);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr unused);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out Rect rect, int size);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard { public ushort key; public ushort scan; public uint flags; public uint time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size=32)] public struct InputUnion { [FieldOffset(0)] public Keyboard keyboard; [FieldOffset(0)] public Mouse mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public InputUnion data; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
  public static void PointInput(int x,int y,IntPtr window,bool scroll,int delta) {
    foreach(int key in new int[]{1,2,4,16,17,18,91,92}) if((GetAsyncKeyState(key)&0x8000)!=0) throw new AccessibilityRefusal("[INPUT_HELD] Release mouse buttons and modifier keys before trying again. No pointer input was sent.");
    // A click naturally activates the visible target under the cursor. Scroll
    // requires foreground focus because inactive-window scrolling is optional.
    if(scroll && GetForegroundWindow()!=window) throw new AccessibilityRefusal("[SCROLL_FOREGROUND_CHANGED] The confirmed window is not foreground. No pointer input was sent.");
    if(GetAncestor(WindowFromPoint(new Point{x=x,y=y}),2)!=window) throw new AccessibilityRefusal("[POINTER_TARGET_OBSCURED] Another window covers the selected point. No pointer input was sent. Use background actions or recapture after the target is visible.");
    if(!SetCursorPos(x,y)) throw new AccessibilityRefusal("[POINTER_MOVE_FAILED] Windows rejected pointer movement. No click or scroll was sent.");
    if(scroll && GetForegroundWindow()!=window) throw new AccessibilityRefusal("[SCROLL_FOREGROUND_CHANGED] Focus changed before pointer input. No pointer input was sent.");
    if(GetAncestor(WindowFromPoint(new Point{x=x,y=y}),2)!=window) throw new AccessibilityRefusal("[POINTER_TARGET_CHANGED] The selected point changed before input. No pointer input was sent. Capture and inspect again.");
    var batch=scroll ? new Input[1] : new Input[2];
    batch[0].data.mouse.flags=scroll?2048u:2u;
    batch[0].data.mouse.data=scroll?unchecked((uint)delta):0;
    if(!scroll) batch[1].data.mouse.flags=4u;
    if(SendInput((uint)batch.Length,batch,Marshal.SizeOf(typeof(Input)))!=batch.Length) {
      if(!scroll) { var release=new Input[1]; release[0].data.mouse.flags=4u; SendInput(1,release,Marshal.SizeOf(typeof(Input))); }
      throw new AccessibilityRefusal("[POINTER_DELIVERY_UNCERTAIN] Windows did not accept all pointer input. Inspect before retrying; do not repeat the action blindly.");
    }
  }
  public static long[] Windows() {
    var list = new List<long>();
    EnumWindows((handle, unused) => { if(IsWindowVisible(handle)) list.Add(handle.ToInt64()); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  public static string OwnedImage(uint pid, string sid) {
    IntPtr process=OpenProcess(0x1000, false, pid), token=IntPtr.Zero;
    if(process==IntPtr.Zero) return null;
    try {
      if(!OpenProcessToken(process, 8, out token)) return null;
      using(var identity=new WindowsIdentity(token)) { if(identity.User.Value != sid) return null; }
      var text=new StringBuilder(32768); uint size=32768;
      return QueryFullProcessImageName(process, 0, text, ref size) ? text.ToString() : null;
    } finally { if(token!=IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
  }
  public static bool UnsupportedText(string text) {
    if(text == null) return false;
    var withoutWebSchemes=Regex.Replace(text, @"(?i)\bhttps?://", "");
    return Regex.IsMatch(withoutWebSchemes, @"(?i)[a-z]:[\\/]|\\\\|file:|%[a-z_]+%");
  }
  public static Input[] BuildInputs(bool textMode, string text, int key) {
    var entries=new List<Input>();
    if(textMode) {
      if(text == null) throw new AccessibilityRefusal("Text input requires text.");
      foreach(char ch in text) {
        entries.Add(new Input{type=1, data=new InputUnion{keyboard=new Keyboard{scan=ch,flags=4}}});
        entries.Add(new Input{type=1, data=new InputUnion{keyboard=new Keyboard{scan=ch,flags=6}}});
      }
    } else {
      if(key <= 0 || key > UInt16.MaxValue) throw new AccessibilityRefusal("Key input requires a nonzero virtual key.");
      entries.Add(new Input{type=1, data=new InputUnion{keyboard=new Keyboard{key=(ushort)key}}});
      entries.Add(new Input{type=1, data=new InputUnion{keyboard=new Keyboard{key=(ushort)key,flags=2}}});
    }
    return entries.ToArray();
  }
  public static void Send(bool textMode, string text, int key, IntPtr confirmedWindow) {
    foreach(int modifier in new int[]{16,17,18,91,92}) if((GetAsyncKeyState(modifier)&0x8000)!=0) throw new AccessibilityRefusal("Release modifier keys before trying again.");
    var batch=BuildInputs(textMode,text,key);
    if(GetForegroundWindow()!=confirmedWindow) throw new AccessibilityRefusal("Focus changed before input. Nothing was sent.");
    if(batch.Length>0 && SendInput((uint)batch.Length,batch,Marshal.SizeOf(typeof(Input))) != batch.Length) throw new AccessibilityRefusal("Windows did not accept all input; inspect before retrying.");
  }
}
'@
  $script:withheldTerms = @(); $script:protectedLabelCount = 0; $script:protectedLabelTerms = @()
  $script:windowDiagnostics = @{ visibleWindows=0; excludedProcesses=0; unavailableProcesses=0; differentSession=0; outsideProfile=0; excludedTitles=0; protectedTitles=0; inspectionErrors=0 }
  $ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $null = [AccessibilityNative]::SetProcessDPIAware()
  $interactiveSession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  $blockedNames = '^(electron|toolsenabled.*|cmd|powershell|powershell_ise|pwsh|wt|windowsterminal|conhost|explorer|totalcmd.*|consent|credentialuibroker|logonui|regedit|mmc|taskmgr)$'
  $blockedLabels = '(?i)password|passcode|credential|api.?key|secret|sign.?in|log.?in|permission|confirm|approve|accessibility'
  $signInAllowedLabels = '(?i)password|passcode|credential|api.?key|secret|permission|confirm|approve|accessibility'
  if ($null -ne $request.allowSignIn -and $request.allowSignIn -isnot [bool]) { Refuse 'Invalid browser sign-in startup option.' }
  # RESTRICTED_BROWSER_HELPERS_START
  # Reporting only. These are the alternatives of $blockedLabels, in the same
  # order, with the name each is reported by. Get-ProtectedTerm says which one
  # matched so the person can be told why; it returns a name from this list and
  # one flag, never the title or label it was given. The decision to withhold
  # is made by $blockedLabels alone, exactly as before.
  $protectedTermPatterns = @('password', 'passcode', 'credential', 'api.?key', 'secret', 'sign.?in', 'log.?in', 'permission', 'confirm', 'approve', 'accessibility')
  $protectedTermNames = @('password', 'passcode', 'credential', 'api key', 'secret', 'sign in', 'log in', 'permission', 'confirm', 'approve', 'accessibility')
  function Get-ProtectedTerm([string]$text, [bool]$allowSignIn = $false) {
    $best = $null
    for ($i = 0; $i -lt $protectedTermPatterns.Count; $i++) {
      if ($allowSignIn -and $i -in @(5, 6)) { continue }
      $found = [regex]::Match($text, '(?i)' + $protectedTermPatterns[$i])
      if ($found.Success -and (!$best -or $found.Index -lt $best.index)) {
        $before = if ($found.Index -gt 0) { $text[$found.Index - 1] } else { [char]' ' }
        $after = if ($found.Index + $found.Length -lt $text.Length) { $text[$found.Index + $found.Length] } else { [char]' ' }
        $best = @{ index = $found.Index; term = $protectedTermNames[$i]; inside = ([char]::IsLetterOrDigit($before) -or [char]::IsLetterOrDigit($after)) }
      }
    }
    if (!$best) { return $null }
    return @{ term = [string]$best.term; insideLongerWord = [bool]$best.inside }
  }
  function Get-RestrictedWindowState([string]$name, [string]$title, [string]$labelPattern) {
    if ($title -match $labelPattern) {
      if ($name -match '^(?i:chrome|msedge)$') { return 'browser-tabs' }
      return 'excluded'
    }
    return 'normal'
  }
  function Get-TitleToken([string]$value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
  }
  function Get-RestrictedControlDisposition([string]$type, [string]$label, [bool]$enabled, [bool]$offscreen, [bool]$hasSelection, [bool]$documentAncestor, [string]$labelPattern) {
    if ($type -ceq 'Document') { return 'prune' }
    if ($type -cne 'TabItem') { return 'continue' }
    if (!$enabled -or $offscreen -or !$hasSelection -or $documentAncestor -or !$label -or $label -match $labelPattern) { return 'exclude' }
    return 'tab'
  }
  # RESTRICTED_BROWSER_HELPERS_END
  function Get-Snapshot([Int64]$handle) {
    try {
      if (![AccessibilityNative]::IsWindowVisible([IntPtr]$handle)) { return $null }
      [uint32]$targetPid = 0
      $null = [AccessibilityNative]::GetWindowThreadProcessId([IntPtr]$handle, [ref]$targetPid)
      if ($targetPid -eq [uint32]$request.appPid) { $script:windowDiagnostics.excludedProcesses++; return $null }
      # Establish account ownership before reading the image path or UI text.
      $imagePath = [AccessibilityNative]::OwnedImage($targetPid, $ownerSid)
      if (!$imagePath) { $script:windowDiagnostics.unavailableProcesses++; return $null }
      if ($imagePath -match '^[a-z]:\\Users\\' -and !$imagePath.StartsWith(([string]$request.profileRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $script:windowDiagnostics.outsideProfile++; return $null }
      $targetProcess = [System.Diagnostics.Process]::GetProcessById([int]$targetPid)
      if ($targetProcess.SessionId -ne $interactiveSession) { $script:windowDiagnostics.differentSession++; return $null }
      $name = [IO.Path]::GetFileNameWithoutExtension($imagePath)
      if ($name -match $blockedNames) { $script:windowDiagnostics.excludedProcesses++; return $null }
      $caption = New-Object System.Text.StringBuilder 512
      $null = [AccessibilityNative]::GetWindowText([IntPtr]$handle, $caption, 512)
      $title = $caption.ToString()
      if (!$title -or $title -match '(?i)ToolsEnabled') { $script:windowDiagnostics.excludedTitles++; return $null }
      $windowLabels = if ($request.allowSignIn -eq $true -and $name -match '^(?i:chrome|msedge)$') { $signInAllowedLabels } else { $blockedLabels }
      $restricted = Get-RestrictedWindowState $name $title $windowLabels
      if ($restricted -eq 'excluded') {
        $script:windowDiagnostics.protectedTitles++
        # Still withheld. Only the matched word is noted, for the window list.
        if ($request.command -eq 'windows' -and $script:withheldTerms.Count -lt 20) { $script:withheldTerms += ,(Get-ProtectedTerm $title) }
        return $null
      }
      foreach ($match in [regex]::Matches($title, '(?i)[a-z]:[\\/]users[\\/][^\\/\s]+')) {
        if ($match.Value.Replace('/', '\') -ine [string]$request.profileRoot) { $script:windowDiagnostics.outsideProfile++; return $null }
      }
      if ($restricted -eq 'browser-tabs') {
        return @{ handle = [string]$handle; pid = $targetPid; start = [string]$targetProcess.StartTime.ToUniversalTime().Ticks; name = $name; title = 'Restricted browser tabs'; titleToken = (Get-TitleToken $title); restricted = 'browser-tabs'; protectedTerm = (Get-ProtectedTerm $title ($request.allowSignIn -eq $true)) }
      }
      return @{ handle = [string]$handle; pid = $targetPid; start = [string]$targetProcess.StartTime.ToUniversalTime().Ticks; name = $name; title = $title }
    } catch { $script:windowDiagnostics.inspectionErrors++; return $null }
  }
  function Assert-Window {
    $current = Get-Snapshot ([Int64]$request.window.handle)
    if (!$current -or $current.pid -ne $request.window.pid -or $current.start -cne $request.window.start -or $current.title -cne $request.window.title -or $current.name -cne $request.window.name -or $current.restricted -cne $request.window.restricted -or $current.titleToken -cne $request.window.titleToken) {
      Refuse 'The window changed, closed or is not permitted. Inspect again.'
    }
    return $current
  }
  function Describe-Control($element) {
    try {
      $info = $element.Current
      if ($info.IsPassword -or !$info.IsEnabled -or $info.IsOffscreen) { $script:excludedCount++; return $null }
      $type = $info.ControlType.ProgrammaticName.Replace('ControlType.', '')
      $script:observedTypes += $type
      $label = if ($type -in @('Edit', 'Document')) {
        if ($info.LabeledBy) { $info.LabeledBy.Current.Name } else { 'Text field' }
      } else { $info.Name }
      if (!$label) { return $null }
      if ($label -match $blockedLabels) {
        $script:protectedLabelCount++
        $matched = Get-ProtectedTerm $label ($blockedLabels -eq $signInAllowedLabels)
        if ($matched -and $script:protectedLabelTerms -notcontains $matched.term) { $script:protectedLabelTerms += $matched.term }
        return $null
      }
      $label = $label.Substring(0, [Math]::Min(240, $label.Length))
      $actions = @()
      $pattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $actions += 'click' }
      if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $actions += 'select' }
      if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $actions += 'toggle' }
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern) -and $pattern.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::LeafNode) { $actions += 'expand' }
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern) -and ($pattern.Current.HorizontallyScrollable -or $pattern.Current.VerticallyScrollable)) { $actions += 'scroll' }
      $textMode = $null
      $pattern = $null
      if ($type -in @('Edit', 'Document', 'ComboBox')) {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
          if (!$pattern.Current.IsReadOnly) { $textMode = 'replace' }
        } elseif ($type -in @('Edit', 'Document') -and $info.IsKeyboardFocusable) {
          $textPattern = $null; $readOnly = $null
          if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
            $readOnly = $textPattern.DocumentRange.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)
          }
          if ($readOnly -ne $true) { $textMode = 'insert' }
        }
        if ($textMode) { $actions += @('type', 'key') }
      }
      $row = @{ runtimeId = ($element.GetRuntimeId() -join '.'); label = $label; type = $type; actions = @($actions); textMode = $textMode }
      # Read only on a requested inspection, never on execution's revalidation.
      # The password/name/visibility checks above precede either text API.
      if ($request.command -eq 'inspect' -and $request.includeText -and ($type -in @('Edit', 'Document') -or ($type -eq 'ComboBox' -and $textMode -eq 'replace'))) {
        $limit = [Math]::Min(2000, $script:textBudget)
        $textPattern = $null; $valuePattern = $null; $content = $null
        if ($type -eq 'ComboBox' -and $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
          $content = $valuePattern.Current.Value
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
          $content = $textPattern.DocumentRange.GetText($limit + 1)
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
          $content = $valuePattern.Current.Value
        }
        if ($null -ne $content) {
          $row.text = $content.Substring(0, [Math]::Min($limit, $content.Length))
          $row.textTruncated = $content.Length -gt $limit
          $script:textBudget -= $row.text.Length
        }
      }
      if ($actions.Count -eq 0 -and !$row.ContainsKey('text')) { return $null }
      return $row
    } catch { throw }
  }
  function Read-Controls($windowRoot) {
    $queue = New-Object System.Collections.Queue
    $dialogQueue = New-Object System.Collections.Queue
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $rootId = $windowRoot.GetRuntimeId() -join '.'
    if (!$rootId) { Refuse 'Window runtime identity unavailable.' }
    $null = $seen.Add($rootId)
    $queue.Enqueue(@{ element=$windowRoot; dialog=$false })
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $count = 0; $visited = 0; $enumerated = 0
    while (($queue.Count + $dialogQueue.Count) -gt 0 -and $count -lt 150 -and $visited -lt 600) {
      $entry = if ($dialogQueue.Count -gt 0) { $dialogQueue.Dequeue() } else { $queue.Dequeue() }
      $element = $entry.element; $visited++; $script:visitedCount++
      $row = Describe-Control $element
      if ($row) { $count++; @{ element = $element; row = $row } }
      $child = $walker.GetFirstChild($element)
      # The two queues share the original 600-pending bound. The independent
      # enumeration cap also stops providers that repeat sibling identities.
      while ($child -and ($queue.Count + $dialogQueue.Count) -lt 600 -and $enumerated -lt 1200) {
        $enumerated++
        $childId = $child.GetRuntimeId() -join '.'
        if ($childId -and $seen.Add($childId)) {
          $dialog = $entry.dialog -or ($child.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and !$child.Current.IsOffscreen)
          $next = @{ element=$child; dialog=$dialog }
          if ($dialog) { $dialogQueue.Enqueue($next) } else { $queue.Enqueue($next) }
        }
        $child = $walker.GetNextSibling($child)
      }
    }
  }
  function Has-DocumentAncestor($element, $windowRoot) {
    try {
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $rootId = $windowRoot.GetRuntimeId() -join '.'
      $parent = $walker.GetParent($element)
      for ($depth = 0; $parent -and $depth -lt 64; $depth++) {
        if (($parent.GetRuntimeId() -join '.') -ceq $rootId) { return $false }
        if ($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { return $true }
        $parent = $walker.GetParent($parent)
      }
      return $true
    } catch { return $true }
  }
  function Read-BrowserTabs($windowRoot) {
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($windowRoot)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $count = 0; $visited = 0
    while ($queue.Count -gt 0 -and $count -lt 150 -and $visited -lt 600) {
      $element = $queue.Dequeue(); $visited++; $script:visitedCount++
      try {
        $type = $element.Current.ControlType.ProgrammaticName.Replace('ControlType.', '')
        $disposition = Get-RestrictedControlDisposition $type $null $false $true $false $false $blockedLabels
        if ($disposition -eq 'prune') { $script:excludedCount++; continue }
        if ($type -ceq 'TabItem') {
          $info = $element.Current
          $selection = $null
          $hasSelection = $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)
          $label = $info.Name
          $documentAncestor = Has-DocumentAncestor $element $windowRoot
          $disposition = Get-RestrictedControlDisposition $type $label $info.IsEnabled $info.IsOffscreen $hasSelection $documentAncestor $blockedLabels
          if ($disposition -eq 'tab') {
            $script:observedTypes += 'TabItem'
            $label = $label.Substring(0, [Math]::Min(240, $label.Length))
            $count++
            @{ element = $element; row = @{ runtimeId = ($element.GetRuntimeId() -join '.'); label = $label; type = 'TabItem'; actions = @('select'); textMode = $null; restrictedBrowserTab = $true } }
          } else { $script:excludedCount++ }
          continue
        }
        $child = $walker.GetFirstChild($element)
        while ($child -and $queue.Count -lt 600) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }
      } catch { $script:excludedCount++ }
    }
  }
  function Focus-Target($element) {
    $script:desktopFailureCode = 'FOCUS_WINDOW_REVALIDATION'
    $script:desktopFailureHResult = $null
    try {
      $null = Assert-Window
      $handle = [IntPtr][Int64]$request.window.handle
      $foregroundBefore = [AccessibilityNative]::GetForegroundWindow()
      $script:desktopFailureCode = 'FOCUS_RESTORE'
      if ([AccessibilityNative]::IsIconic($handle)) { $null = [AccessibilityNative]::ShowWindow($handle, 9) }
      if ([AccessibilityNative]::GetForegroundWindow() -ne $handle) {
        $script:desktopFailureCode = 'FOCUS_WINDOW_REVALIDATION'
        $null = Assert-Window
        $script:desktopFailureCode = 'FOCUS_FOREGROUND_CHANGED'
        $foregroundNow = [AccessibilityNative]::GetForegroundWindow()
        if ($foregroundNow -ne $handle -and $foregroundNow -ne $foregroundBefore) { throw 'Focus guard declined.' }
        if ($foregroundNow -ne $handle) {
          # Raise only the confirmed window without activating, moving, resizing,
          # changing topmost status, joining queues, or synthesizing user input.
          $script:desktopFailureCode = 'FOCUS_RAISE_FAILED'
          if (![AccessibilityNative]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x13)) { throw 'Focus guard declined.' }
          $script:desktopFailureCode = 'FOCUS_FOREGROUND_CHANGED'
          $foregroundNow = [AccessibilityNative]::GetForegroundWindow()
          if ($foregroundNow -ne $handle -and $foregroundNow -ne $foregroundBefore) { throw 'Focus guard declined.' }
          if ($foregroundNow -ne $handle) {
            $script:desktopFailureCode = 'FOCUS_NATIVE_REQUEST'
            $null = [AccessibilityNative]::SetForegroundWindow($handle)
            $focusWait = [Diagnostics.Stopwatch]::StartNew()
            while ([AccessibilityNative]::GetForegroundWindow() -ne $handle -and $focusWait.ElapsedMilliseconds -lt 500) { [Threading.Thread]::Sleep(25) }
          }
        }
      }
      # A top-level provider need not be keyboard-focusable. Native activation
      # is the only window focus request; UIA SetFocus is for a selected field.
      $script:desktopFailureCode = 'FOCUS_NATIVE_NOT_FOREGROUND'
      if ([AccessibilityNative]::GetForegroundWindow() -ne $handle) { throw 'Focus guard declined.' }
      $script:desktopFailureCode = 'FOCUS_WINDOW_REVALIDATION'
      $null = Assert-Window
      $script:desktopFailureCode = 'FOCUS_FOREGROUND_CHANGED'
      if ([AccessibilityNative]::GetForegroundWindow() -ne $handle) { throw 'Focus guard declined.' }
      if ($element) {
        $script:desktopFailureCode = 'FOCUS_UIA_FIELD_CALL'
        $element.SetFocus()
        $fieldWait = [Diagnostics.Stopwatch]::StartNew()
        do {
          $script:desktopFailureCode = 'FOCUS_FOREGROUND_CHANGED'
          if ([AccessibilityNative]::GetForegroundWindow() -ne $handle) { throw 'Focus guard declined.' }
          $script:desktopFailureCode = 'FOCUS_FIELD_MISMATCH'
          $focusedElement = [System.Windows.Automation.AutomationElement]::FocusedElement
          $fieldMatches = $focusedElement -and (($focusedElement.GetRuntimeId() -join '.') -ceq $request.control.runtimeId)
          if ($fieldMatches -or $fieldWait.ElapsedMilliseconds -ge 500) { break }
          [Threading.Thread]::Sleep(25)
        } while ($true)
        if (!$fieldMatches) { throw 'Focus guard declined.' }
      }
      $script:desktopFailureCode = 'FOCUS_WINDOW_REVALIDATION'
      $null = Assert-Window
      $script:desktopFailureCode = 'FOCUS_FOREGROUND_CHANGED'
      if ([AccessibilityNative]::GetForegroundWindow() -ne $handle) { throw 'Focus guard declined.' }
      $script:desktopFailureCode = $null
    } catch {
      # Only provider-call failures expose an HRESULT. No provider message,
      # stack, UI text, process identifiers, title, or path leaves this helper.
      if ($script:desktopFailureCode -cin @('FOCUS_UIA_ROOT_CALL', 'FOCUS_UIA_FIELD_CALL')) {
        $failureException = $_.Exception
        for ($depth = 0; $failureException.InnerException -and $depth -lt 4; $depth++) { $failureException = $failureException.InnerException }
        $script:desktopFailureHResult = [int]$failureException.HResult
      }
      throw
    }
  }
  function Window-Actions($element) {
    $pattern = $null
    if (!$element.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pattern)) { return }
    if ($pattern.Current.WindowInteractionState -eq [System.Windows.Automation.WindowInteractionState]::BlockedByModalWindow) { return }
    'restore'; 'close'
    if ($pattern.Current.CanMinimize) { 'minimize' }
    if ($pattern.Current.CanMaximize) { 'maximize' }
  }
  if ($request.command -eq 'windows') {
    $script:withheldTerms = @()
    $visibleWindows = @([AccessibilityNative]::Windows())
    $script:windowDiagnostics.visibleWindows = $visibleWindows.Count
    $listed = @($visibleWindows | ForEach-Object { Get-Snapshot $_ } | Select-Object -First 80)
    # One extra row per withheld window: the matched word and nothing else.
    $result = @($listed) + @($script:withheldTerms | Where-Object { $_ } | ForEach-Object { @{ withheld = 'protected-title'; protectedTerm = $_ } }) + @(@{ diagnostics = $script:windowDiagnostics })
  } else {
    $currentWindow = Assert-Window
    if ($request.allowSignIn -eq $true -and $currentWindow.name -match '^(?i:chrome|msedge)$') { $blockedLabels = $signInAllowedLabels }
    $restrictedBrowser = $currentWindow.restricted -ceq 'browser-tabs'
    if ($restrictedBrowser -and $request.command -notin @('inspect', 'action')) { Refuse 'Protected browser windows permit tab inspection and selection only.' }
    if ($restrictedBrowser -and $request.command -eq 'inspect' -and $request.includeText) { Refuse 'Protected browser tabs do not permit page text inspection.' }
    if ($restrictedBrowser -and $request.command -eq 'action' -and $request.kind -cne 'select') { Refuse 'Protected browser windows permit tab selection only.' }
    $windowRoot = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$request.window.handle)
    if ($request.command -eq 'pointer') {
      $frame = $request.frame; $handle = [IntPtr][Int64]$request.window.handle
      $rect = New-Object AccessibilityNative+Rect
      if (![AccessibilityNative]::GetWindowRect($handle, [ref]$rect)) { Refuse 'Window dimensions unavailable.' }
      if ($rect.left -ne $frame.left -or $rect.top -ne $frame.top -or $rect.right -ne $frame.right -or $rect.bottom -ne $frame.bottom) {
        $script:desktopFailureCode = 'WINDOW_GEOMETRY_CHANGED'; Refuse 'Window geometry changed.'
      }
      if ($request.leftHalf) {
        Add-Type -AssemblyName System.Windows.Forms
        $area = [System.Windows.Forms.Screen]::FromHandle($handle).WorkingArea
        $visible = New-Object AccessibilityNative+Rect
        if ([AccessibilityNative]::DwmGetWindowAttribute($handle, 9, [ref]$visible, 16) -ne 0) { $visible = $rect }
        if ($visible.left -lt $area.Left -or $visible.right -gt $area.Left + [Math]::Floor($area.Width / 2)) { $script:desktopFailureCode = 'WINDOW_OUTSIDE_LEFT_HALF'; Refuse 'Window is outside the left half of its monitor.' }
      }
      if ($request.kind -notin @('click','scroll') -or $request.x -lt 0 -or $request.y -lt 0 -or $request.x -ge $frame.width -or $request.y -ge $frame.height) { Refuse 'Unsupported pointer request.' }
      $delta = 0
      if ($request.kind -eq 'scroll') {
        if ($request.direction -notin @('up','down') -or $request.amount -lt 1 -or $request.amount -gt 5) { Refuse 'Unsupported scroll.' }
        $delta = [int]$request.amount * $(if ($request.direction -eq 'up') { 120 } else { -120 })
      }
      $x = $rect.left + [int][Math]::Floor($request.x * ($rect.right - $rect.left) / $frame.width)
      $y = $rect.top + [int][Math]::Floor($request.y * ($rect.bottom - $rect.top) / $frame.height)
      if ($request.leftHalf -and ($x -lt $area.Left -or $x -ge $area.Left + [Math]::Floor($area.Width / 2))) { $script:desktopFailureCode = 'POINT_OUTSIDE_LEFT_HALF'; Refuse 'Point is outside the left half of the monitor.' }
      if ($request.kind -eq 'scroll') { Focus-Target $null }
      $null = Assert-Window
      [AccessibilityNative]::PointInput($x,$y,$handle,($request.kind -eq 'scroll'),$delta)
      $result = @{ status = 'completed' }
    } elseif ($request.command -eq 'position-left') {
      Add-Type -AssemblyName System.Windows.Forms
      $handle = [IntPtr][Int64]$request.window.handle
      $area = [System.Windows.Forms.Screen]::FromHandle($handle).WorkingArea
      if ([AccessibilityNative]::IsIconic($handle) -or [AccessibilityNative]::IsZoomed($handle)) { $null = [AccessibilityNative]::ShowWindow($handle, 9) }
      $null = Assert-Window
      $width = [int][Math]::Floor($area.Width / 2)
      if (![AccessibilityNative]::SetWindowPos($handle, [IntPtr]::Zero, $area.Left, $area.Top, $width, $area.Height, 0x14)) { Refuse 'Window positioning failed.' }
      $rect = New-Object AccessibilityNative+Rect
      if (![AccessibilityNative]::GetWindowRect($handle, [ref]$rect) -or $rect.left -lt $area.Left -or $rect.right -gt $area.Left + $width) { $script:desktopFailureCode = 'WINDOW_DID_NOT_FIT_LEFT_HALF'; Refuse 'Window did not fit the left half; no input was sent.' }
      $result = @{ status = 'positioned-left'; width = $width; height = $area.Height }
    } elseif ($request.command -eq 'capture') {
      Add-Type -AssemblyName System.Drawing
      $handle = [IntPtr][Int64]$request.window.handle
      $rect = New-Object AccessibilityNative+Rect
      if (![AccessibilityNative]::GetWindowRect($handle, [ref]$rect)) { Refuse 'Window dimensions unavailable.' }
      $width = $rect.right - $rect.left; $height = $rect.bottom - $rect.top
      if ($width -lt 1 -or $height -lt 1 -or $width -gt 8192 -or $height -gt 8192 -or $width * $height -gt 33554432) { Refuse 'Window dimensions outside capture bound.' }
      $bitmap = New-Object System.Drawing.Bitmap($width, $height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $small = $null; $stream = New-Object System.IO.MemoryStream
      try {
        $dc = $graphics.GetHdc()
        try { if (![AccessibilityNative]::PrintWindow($handle, $dc, 2)) { Refuse 'Window capture unavailable.' } } finally { $graphics.ReleaseHdc($dc) }
        $null = Assert-Window
        $after = New-Object AccessibilityNative+Rect
        if (![AccessibilityNative]::GetWindowRect($handle, [ref]$after) -or $after.left -ne $rect.left -or $after.top -ne $rect.top -or $after.right -ne $rect.right -or $after.bottom -ne $rect.bottom) { $script:desktopFailureCode = 'WINDOW_MOVED_DURING_CAPTURE'; Refuse 'Window moved during capture.' }
        $scale = [Math]::Min([double]1, [double]1280 / [double][Math]::Max($width, $height))
        $outWidth = [int][Math]::Max(1, [Math]::Floor($width * $scale)); $outHeight = [int][Math]::Max(1, [Math]::Floor($height * $scale))
        $small = New-Object System.Drawing.Bitmap($bitmap, $outWidth, $outHeight)
        $small.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        if ($stream.Length -gt 2MB) { Refuse 'Window image exceeded capture bound.' }
        $result = @{ png = [Convert]::ToBase64String($stream.ToArray()); width = $outWidth; height = $outHeight; geometry = @{ left=$rect.left; top=$rect.top; right=$rect.right; bottom=$rect.bottom } }
      } finally { if ($small) { $small.Dispose() }; $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
    } elseif ($request.command -eq 'inspect') {
      $script:visitedCount = 0; $script:excludedCount = 0; $script:observedTypes = @()
      $script:textBudget = 12000
      if ($restrictedBrowser) {
        $rows = @(Read-BrowserTabs $windowRoot | ForEach-Object { $_.row })
        $result = @{ controls = $rows; windowActions = @(); visited = $script:visitedCount; hiddenDisabledOrPassword = $script:excludedCount; types = $script:observedTypes; restrictedState = 'browser-tabs-only'; diagnostic = 'Protected browser page detected. Only existing non-sensitive browser tabs may be inspected and selected. Page content, screenshots, pointer input and other actions are blocked.' }
      } else {
        $rows = @(Read-Controls $windowRoot | ForEach-Object { $_.row })
        $result = @{ controls = $rows; windowActions = @(Window-Actions $windowRoot); visited = $script:visitedCount; hiddenDisabledOrPassword = $script:excludedCount; types = $script:observedTypes; protectedLabels = @{ count = [int]$script:protectedLabelCount; terms = @($script:protectedLabelTerms) } }
      }
    } elseif ($request.kind -eq 'focus') {
      Focus-Target $null
      $result = @{ status = 'completed' }
    } elseif ($request.kind -eq 'window') {
      if ($request.value -notin @(Window-Actions $windowRoot)) { Refuse 'The requested window action is not available.' }
      $windowPattern = $windowRoot.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
      $null = Assert-Window
      if ($request.value -eq 'close') {
        # Normal application close only. An unsaved-work dialog may remain;
        # never dismiss it automatically, kill a process or claim it exited.
        $windowPattern.Close()
        $result = @{ status = 'close-requested'; message = 'Normal close requested. Inspect again for an unsaved-work dialog or to verify closure.' }
      } else {
        $states = @{ minimize = [System.Windows.Automation.WindowVisualState]::Minimized; maximize = [System.Windows.Automation.WindowVisualState]::Maximized; restore = [System.Windows.Automation.WindowVisualState]::Normal }
        if (!$states.ContainsKey([string]$request.value)) { Refuse 'Unsupported window state.' }
        $wanted = $states[[string]$request.value]
        $windowPattern.SetWindowVisualState($wanted)
        # Providers can acknowledge before the Windows transition finishes.
        # Observe briefly, without repeating the command or changing focus.
        $transition = [Diagnostics.Stopwatch]::StartNew()
        while ($windowPattern.Current.WindowVisualState -ne $wanted -and $transition.ElapsedMilliseconds -lt 1000) {
          [Threading.Thread]::Sleep(20)
        }
        if ($windowPattern.Current.WindowVisualState -ne $wanted) { Refuse 'The window did not reach the requested state. Inspect before retrying.' }
        $null = Assert-Window
        $result = @{ status = 'completed'; windowState = [string]$request.value }
      }
    } else {
      if ($restrictedBrowser) {
        $script:visitedCount = 0; $script:excludedCount = 0; $script:observedTypes = @()
        $target = @(Read-BrowserTabs $windowRoot | Where-Object { $_.row.runtimeId -ceq $request.control.runtimeId }) | Select-Object -First 1
      } else {
        $target = @(Read-Controls $windowRoot | Where-Object { $_.row.runtimeId -ceq $request.control.runtimeId }) | Select-Object -First 1
      }
      if (!$target -or $target.row.label -cne $request.control.label -or $target.row.type -cne $request.control.type -or $target.row.textMode -cne $request.control.textMode -or $target.row.restrictedBrowserTab -cne $request.control.restrictedBrowserTab -or $request.kind -notin $target.row.actions) {
        Refuse 'The confirmed control changed or is no longer available. Inspect again.'
      }
      $null = Assert-Window
      if ($restrictedBrowser -and ($request.kind -cne 'select' -or $target.row.type -cne 'TabItem' -or $target.row.restrictedBrowserTab -ne $true -or (Has-DocumentAncestor $target.element $windowRoot))) {
        Refuse 'Protected browser windows permit observed browser-chrome tab selection only.'
      }
      if ($request.kind -eq 'click') {
        $target.element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      } elseif ($request.kind -eq 'type') {
        if ($request.text.Length -gt 2000 -or [AccessibilityNative]::UnsupportedText([string]$request.text)) { Refuse 'Unsupported desktop text.' }
        if ($target.row.textMode -eq 'replace') {
          $target.element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$request.text)
        } else {
          Focus-Target $target.element
          [AccessibilityNative]::Send($true, [string]$request.text, 0, [IntPtr][Int64]$request.window.handle)
        }
      } elseif ($request.kind -eq 'key') {
        $keys = @{ Enter = 13; Tab = 9; Escape = 27; Backspace = 8; ArrowUp = 38; ArrowDown = 40; ArrowLeft = 37; ArrowRight = 39; Home = 36; End = 35; PageUp = 33; PageDown = 34; Delete = 46 }
        if (!$keys.ContainsKey([string]$request.value)) { Refuse 'Unsupported desktop key.' }
        Focus-Target $target.element
        [AccessibilityNative]::Send($false, $null, [int]$keys[[string]$request.value], [IntPtr][Int64]$request.window.handle)
      } elseif ($request.kind -eq 'select') {
        $selection = $null
        if (!$target.element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) { Refuse 'The item is no longer selectable. Inspect again.' }
        $selection.Select()
        if (!$selection.Current.IsSelected) { Refuse 'The item did not become selected. Inspect before retrying.' }
      } elseif ($request.kind -eq 'toggle') {
        if ($request.value -notin @('on', 'off')) { Refuse 'Unsupported toggle state.' }
        $toggle = $target.element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        $wanted = if ($request.value -eq 'on') { [System.Windows.Automation.ToggleState]::On } else { [System.Windows.Automation.ToggleState]::Off }
        # Explicit target state, not a blind inversion or an automatic retry.
        if ($toggle.Current.ToggleState -ne $wanted) { $toggle.Toggle() }
        if ($toggle.Current.ToggleState -ne $wanted) { Refuse 'The control did not reach the requested state. Inspect before retrying.' }
      } elseif ($request.kind -eq 'expand') {
        $expand = $target.element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($request.value -eq 'open') { $expand.Expand() }
        elseif ($request.value -eq 'closed') { $expand.Collapse() }
        else { Refuse 'Unsupported expansion state.' }
        $wanted = if ($request.value -eq 'open') { [System.Windows.Automation.ExpandCollapseState]::Expanded } else { [System.Windows.Automation.ExpandCollapseState]::Collapsed }
        if ($expand.Current.ExpandCollapseState -ne $wanted) { Refuse 'The control did not reach the requested expansion state. Inspect before retrying.' }
      } elseif ($request.kind -eq 'scroll') {
        $scroll = $target.element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
        $horizontal = [System.Windows.Automation.ScrollAmount]::NoAmount
        $vertical = [System.Windows.Automation.ScrollAmount]::NoAmount
        switch ($request.value) {
          'up' { $vertical = [System.Windows.Automation.ScrollAmount]::LargeDecrement }
          'down' { $vertical = [System.Windows.Automation.ScrollAmount]::LargeIncrement }
          'left' { $horizontal = [System.Windows.Automation.ScrollAmount]::LargeDecrement }
          'right' { $horizontal = [System.Windows.Automation.ScrollAmount]::LargeIncrement }
          default { Refuse 'Unsupported scroll direction.' }
        }
        $scroll.Scroll($horizontal, $vertical)
      } else { Refuse 'Unsupported desktop action.' }
      $result = @{ status = 'completed' }
    }
  }
  [Console]::WriteLine((@{ ok = $true; result = $result } | ConvertTo-Json -Depth 12 -Compress))
} catch {
  # Exceptions from an application provider can contain window content, so the
  # reason is passed on only when this file wrote it: through Refuse, or as an
  # AccessibilityRefusal from the compiled input helpers (which PowerShell
  # wraps in a method-invocation exception).
  $failure = New-SafeFocusFailure $script:desktopFailureCode $script:desktopFailureHResult
  if (!$failure) { $failure = New-SafeDesktopFailure $script:desktopFailureCode }
  if ($failure) {
    [Console]::WriteLine(($failure | ConvertTo-Json -Compress)); exit 1
  }
  $reason = $null
  $cause = $_.Exception
  for ($depth = 0; $cause -and $depth -lt 4; $depth++) {
    if ($cause.GetType().FullName -ceq 'AccessibilityRefusal') { $reason = $cause.Message; break }
    $cause = $cause.InnerException
  }
  if (!$reason -and $script:refusal -and $_.Exception.Message -ceq $script:refusal) { $reason = $script:refusal }
  if ($reason) {
    [Console]::WriteLine((@{ ok = $false; refusal = $true; error = $reason } | ConvertTo-Json -Compress)); exit 1
  }
  [Console]::WriteLine((@{ ok = $false; error = 'Windows could not safely complete this request. Inspect before retrying. Helper line: ' + $_.InvocationInfo.ScriptLineNumber } | ConvertTo-Json -Compress))
  exit 1
}

param(
  [Parameter(Mandatory = $true)][string]$PipeName,
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$CommandBase64,
  [Parameter(Mandatory = $true)][string]$ArgumentsBase64,
  [Parameter(Mandatory = $true)][string]$WorkingDirectoryBase64,
  [Parameter(Mandatory = $true)][int]$CleanupTimeoutMs,
  [Parameter(Mandatory = $true)][int]$HandshakeTimeoutMs,
  # OPTIONAL. Absent (the default) reproduces the exact original behavior:
  # compile $source fresh, every launch. See the caching block at the bottom
  # of this file for what this enables and why it is always safe to omit.
  [Parameter(Mandatory = $false)][string]$AssemblyCacheDirectoryBase64 = '',
  [Parameter(Mandatory = $false)][string]$FolderScopeBase64 = '',
  # Provider transports use the job root as the lifetime authority. A tool the
  # provider launched must not outlive that root merely because Windows
  # re-parented it before the Node owner could issue a PID-tree kill.
  [Parameter(Mandatory = $false)][switch]$TerminateDescendantsOnRootExit,
  [Parameter(Mandatory = $false)][switch]$VerbatimArguments
)

$ErrorActionPreference = 'Stop'

# This is a shipped implementation component, not a general PowerShell command
# surface. The Node caller passes only base64-encoded data arguments, and the C#
# launcher calls CreateProcessW directly with shell expansion disabled.
$source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class ToolsEnabledWindowsJobWrapper
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const short SW_HIDE = 0;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int WRAPPER_FAILURE_EXIT = 250;
    private const int TERMINATED_EXIT = 124;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUserW(IntPtr token, string applicationName,
        StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);
    private static FleetWindowsFolderScope activeFolderScope;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr information, uint informationLength, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(
        IntPtr sourceProcess,
        IntPtr sourceHandle,
        IntPtr targetProcess,
        out IntPtr targetHandle,
        uint desiredAccess,
        bool inheritHandle,
        uint options);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private sealed class LaunchState
    {
        public IntPtr Job = IntPtr.Zero;
        public IntPtr RootProcess = IntPtr.Zero;
        public IntPtr RootThread = IntPtr.Zero;
        public int RootPid;
        public long RootStartTicks;
    }

    // Keep root-process creation distinct from later containment failures.
    // The Node bridge may report the former as an executable spawn refusal,
    // while assignment/resume/cleanup failures must retain their stronger
    // generic wrapper-failure classification.
    private sealed class ChildSpawnException : Exception
    {
        public ChildSpawnException(Exception inner)
            : base("The contained child could not be created suspended. " + inner.Message, inner) { }
    }

    private sealed class RootWaitException : Exception
    {
        public RootWaitException(string message, uint waitResult, uint nativeError)
            : base(message + " [waitResult=" + waitResult.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + ";win32Error=" + nativeError.ToString(System.Globalization.CultureInfo.InvariantCulture) + "]") { }
    }

    // Job accounting and the root's waitable state are separate observations.
    // A pending observation must return to Run so cancellation and authenticated
    // control requests remain serviced while both exact handles are retained.
    private sealed class RootSignalWait
    {
        private readonly int timeoutMs;
        private long firstZeroAt = -1;

        public RootSignalWait(int timeoutMs)
        {
            if (timeoutMs <= 0) throw new ArgumentOutOfRangeException("timeoutMs");
            this.timeoutMs = timeoutMs;
        }

        public bool Observe(uint waitResult, uint nativeError, long elapsedMs)
        {
            if (waitResult == WAIT_FAILED)
                throw new RootWaitException("The contained root exit state could not be measured.", waitResult, nativeError);
            if (waitResult == WAIT_OBJECT_0) return true;
            if (waitResult != WAIT_TIMEOUT)
                throw new RootWaitException("The retained root wait returned an unexpected result.", waitResult, nativeError);
            if (firstZeroAt < 0) firstZeroAt = elapsedMs;
            if (elapsedMs - firstZeroAt >= timeoutMs)
                throw new RootWaitException("The job reached zero while its retained root handle was not signalled.", waitResult, 0);
            return false;
        }
    }

    private static bool Invalid(IntPtr handle)
    {
        return handle == IntPtr.Zero || handle == new IntPtr(-1);
    }

    private static void Close(ref IntPtr handle)
    {
        IntPtr value = handle;
        handle = IntPtr.Zero;
        if (!Invalid(value)) CloseHandle(value);
    }

    private static long CreationTicks(IntPtr process)
    {
        FILETIME creation, exit, kernel, user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read retained process creation identity.");
        long fileTime = ((long)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
        return DateTime.FromFileTimeUtc(fileTime).Ticks;
    }

    private static string QuoteArgument(string value)
    {
        if (value == null) value = String.Empty;
        bool quote = value.Length == 0;
        for (int i = 0; i < value.Length && !quote; i++)
        {
            char ch = value[i];
            if (Char.IsWhiteSpace(ch) || ch == '"') quote = true;
        }
        if (!quote) return value;
        StringBuilder result = new StringBuilder();
        result.Append('"');
        int slashes = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (ch == '\\')
            {
                slashes += 1;
                continue;
            }
            if (ch == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(ch);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static StringBuilder CommandLine(string command, string[] arguments, bool verbatimArguments)
    {
        StringBuilder value = new StringBuilder(QuoteArgument(command));
        if (arguments != null)
        {
            foreach (string argument in arguments)
            {
                value.Append(' ');
                // Explicit shell-tail mode is selected only by the caller
                // that launches cmd /c. Do not CRT-escape its authored syntax.
                value.Append(verbatimArguments ? argument : QuoteArgument(argument));
            }
        }
        return value;
    }

    private static IntPtr DuplicateStandard(int kind)
    {
        IntPtr source = GetStdHandle(kind);
        if (Invalid(source)) throw new Win32Exception(Marshal.GetLastWin32Error(), "A required inherited standard handle is unavailable.");
        IntPtr duplicate;
        IntPtr current = GetCurrentProcess();
        if (!DuplicateHandle(current, source, current, out duplicate, 0, true, DUPLICATE_SAME_ACCESS))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "A required standard handle could not be made inheritable.");
        return duplicate;
    }

    private static void ConfigureKillOnClose(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "KILL_ON_JOB_CLOSE could not be established.");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static uint ActiveProcesses(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, buffer, (uint)size, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "The Job Object active-process count could not be measured.");
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
                Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return info.ActiveProcesses;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static bool WaitForZero(IntPtr job, int timeoutMs)
    {
        Stopwatch clock = Stopwatch.StartNew();
        do
        {
            if (ActiveProcesses(job) == 0) return true;
            Thread.Sleep(10);
        }
        while (clock.ElapsedMilliseconds < timeoutMs);
        return ActiveProcesses(job) == 0;
    }

    private static LaunchState Launch(string command, string[] arguments, string workingDirectory, bool verbatimArguments)
    {
        LaunchState state = new LaunchState();
        IntPtr stdin = IntPtr.Zero;
        IntPtr stdout = IntPtr.Zero;
        IntPtr stderr = IntPtr.Zero;
        try
        {
            state.Job = CreateJobObject(IntPtr.Zero, null);
            if (Invalid(state.Job)) throw new Win32Exception(Marshal.GetLastWin32Error(), "The Job Object could not be created.");
            ConfigureKillOnClose(state.Job);

            stdin = DuplicateStandard(STD_INPUT_HANDLE);
            stdout = DuplicateStandard(STD_OUTPUT_HANDLE);
            stderr = DuplicateStandard(STD_ERROR_HANDLE);
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
            startup.wShowWindow = SW_HIDE;
            startup.hStdInput = stdin;
            startup.hStdOutput = stdout;
            startup.hStdError = stderr;
            if (activeFolderScope != null) startup.lpDesktop = activeFolderScope.DesktopName;

            PROCESS_INFORMATION process;
            bool created = activeFolderScope == null
                ? CreateProcessW(null, CommandLine(command, arguments, verbatimArguments), IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, workingDirectory, ref startup, out process)
                : CreateProcessAsUserW(activeFolderScope.Token, null, CommandLine(command, arguments, verbatimArguments), IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, workingDirectory, ref startup, out process);
            if (!created)
                throw new ChildSpawnException(new Win32Exception(Marshal.GetLastWin32Error()));
            state.RootProcess = process.hProcess;
            state.RootThread = process.hThread;
            state.RootPid = checked((int)process.dwProcessId);
            state.RootStartTicks = CreationTicks(state.RootProcess);

            // No user-mode instruction in the root has run yet. Assignment at
            // this point closes the historical spawn->tree-registration race.
            if (!AssignProcessToJobObject(state.Job, state.RootProcess))
            {
                int code = Marshal.GetLastWin32Error();
                TerminateProcess(state.RootProcess, (uint)WRAPPER_FAILURE_EXIT);
                WaitForSingleObject(state.RootProcess, 5000);
                throw new Win32Exception(code, "The suspended child could not be assigned to its Job Object.");
            }
            uint resumed = ResumeThread(state.RootThread);
            if (resumed == 0xFFFFFFFF)
            {
                int code = Marshal.GetLastWin32Error();
                TerminateJobObject(state.Job, (uint)WRAPPER_FAILURE_EXIT);
                WaitForZero(state.Job, 5000);
                throw new Win32Exception(code, "The contained child could not be resumed.");
            }
            return state;
        }
        catch
        {
            Close(ref state.RootThread);
            Close(ref state.RootProcess);
            Close(ref state.Job);
            throw;
        }
        finally
        {
            Close(ref stdin);
            Close(ref stdout);
            Close(ref stderr);
        }
    }

    private static string ErrorLine(string code, Exception error)
    {
        string message = error == null ? "The Windows Job Object wrapper failed." : error.Message;
        if (message.Length > 600) message = message.Substring(0, 600);
        return "ERROR " + code + " " + Convert.ToBase64String(Encoding.UTF8.GetBytes(message));
    }

    private static bool FixedEquals(string left, string right)
    {
        if (left == null || right == null) return false;
        byte[] a = Encoding.UTF8.GetBytes(left);
        byte[] b = Encoding.UTF8.GetBytes(right);
        int difference = a.Length ^ b.Length;
        int count = Math.Max(a.Length, b.Length);
        for (int i = 0; i < count; i++)
        {
            byte av = i < a.Length ? a[i] : (byte)0;
            byte bv = i < b.Length ? b[i] : (byte)0;
            difference |= av ^ bv;
        }
        return difference == 0;
    }

    private static bool ValidTermination(string line, string token, long wrapperTicks, LaunchState state)
    {
        string[] parts = (line ?? String.Empty).Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 5 || parts[0] != "TERMINATE" || !FixedEquals(parts[1], token)) return false;
        long expectedWrapper, expectedRoot;
        int expectedPid;
        return Int64.TryParse(parts[2], out expectedWrapper)
            && Int32.TryParse(parts[3], out expectedPid)
            && Int64.TryParse(parts[4], out expectedRoot)
            && expectedWrapper == wrapperTicks
            && expectedPid == state.RootPid
            && expectedRoot == state.RootStartTicks;
    }

    public sealed class HandshakeDeadlineException : TimeoutException
    {
        public HandshakeDeadlineException() : base("The Windows job handshake exhausted its launch deadline.") {}
    }

    // Both owner wait stages consume the same monotonic budget. The delegate
    // seam permits inert controlled-clock tests without creating any process.
    public static int RemainingHandshake(int budgetMs, Func<long> elapsedMs)
    {
        long elapsed = elapsedMs();
        if (elapsed < 0 || elapsed >= budgetMs) throw new HandshakeDeadlineException();
        return (int)(budgetMs - elapsed);
    }

    public static void CheckOwnerBeforeLaunch(bool cancelled, bool ownerGone)
    {
        if (cancelled || ownerGone)
            throw new OperationCanceledException("The owner cancelled or disconnected before root launch.");
    }

    public static void AuthenticateOwner(Func<int, string> read, Func<long> elapsedMs, int budgetMs, string token)
    {
        string hello;
        try { hello = read(RemainingHandshake(budgetMs, elapsedMs)); }
        catch (TimeoutException) { throw new HandshakeDeadlineException(); }
        if (!FixedEquals(hello, "OWNER " + token))
            throw new InvalidOperationException("The launcher did not authenticate the private status channel.");
        RemainingHandshake(budgetMs, elapsedMs);
    }

    private static string ReadLineBounded(StreamReader reader, int timeoutMs)
    {
        Task<string> read = reader.ReadLineAsync();
        if (!read.Wait(timeoutMs)) throw new TimeoutException("The control client did not send a bounded request.");
        return read.Result;
    }

    private static NamedPipeServerStream AwaitOwner(string pipeName, int timeoutMs)
    {
        NamedPipeServerStream server = new NamedPipeServerStream(
            pipeName, PipeDirection.InOut, 2, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        IAsyncResult pending = server.BeginWaitForConnection(null, null);
        if (!pending.AsyncWaitHandle.WaitOne(timeoutMs))
        {
            server.Dispose();
            throw new TimeoutException("The launcher did not connect to the private status channel.");
        }
        server.EndWaitForConnection(pending);
        return server;
    }

    // Keep an idle accept pending across control-loop polls. Disposing the
    // listener on every timeout can close a client that connected just as
    // that timeout elapsed, losing an authenticated cancellation to EOF.
    private sealed class ControlListener : IDisposable
    {
        private readonly string pipeName;
        private NamedPipeServerStream server;
        private Task pending;

        public ControlListener(string name) { pipeName = name; }

        public NamedPipeServerStream Poll(int pollMs)
        {
            if (server == null)
            {
                server = new NamedPipeServerStream(
                    pipeName, PipeDirection.InOut, 2, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                pending = Task.Factory.FromAsync(server.BeginWaitForConnection, server.EndWaitForConnection, null);
            }
            try { if (!pending.Wait(pollMs)) return null; }
            catch (AggregateException error)
            {
                Dispose();
                throw error.GetBaseException();
            }
            NamedPipeServerStream connected = server;
            server = null;
            pending = null;
            return connected;
        }

        public void Dispose()
        {
            NamedPipeServerStream waiting = server;
            Task connection = pending;
            server = null;
            pending = null;
            if (waiting != null) waiting.Dispose();
            // Disposing a still-pending accept can fault its task. Observe
            // that cleanup result without blocking the cancellation loop.
            if (connection != null) connection.ContinueWith(task => {
                AggregateException observed = task.Exception;
            }, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
        }
    }

    // Call only after this same retained process handle was observed signalled.
    // A process object cannot return to nonsignalled, and 259 can be its actual
    // exit code; it is not evidence of a running process after that observation.
    private static int ReadSignalledRootExitCode(LaunchState state)
    {
        uint code;
        if (!GetExitCodeProcess(state.RootProcess, out code))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The contained root exit code could not be read.");
        return unchecked((int)code);
    }

    public static int RunWithFolderScope(string pipeName, string token, string command, string[] arguments,
        string workingDirectory, int cleanupTimeoutMs, int handshakeTimeoutMs,
        bool terminateDescendantsOnRootExit, bool verbatimArguments, string[] reads, string[] writes, bool readAll)
    {
        using (var boundary = new FleetWindowsFolderScope(reads, writes, readAll)) {
            activeFolderScope=boundary;
            try { return Run(pipeName,token,command,arguments,workingDirectory,cleanupTimeoutMs,handshakeTimeoutMs,terminateDescendantsOnRootExit,verbatimArguments); }
            finally { activeFolderScope=null; }
        }
    }

    public static int Run(string pipeName, string token, string command, string[] arguments,
        string workingDirectory, int cleanupTimeoutMs, int handshakeTimeoutMs,
        bool terminateDescendantsOnRootExit, bool verbatimArguments)
    {
        NamedPipeServerStream owner = null;
        StreamReader ownerReader = null;
        StreamWriter ownerWriter = null;
        ControlListener controls = null;
        LaunchState state = null;
        volatileOwnerGone = false;
        volatileCancel = false;
        try
        {
            Stopwatch handshakeClock = Stopwatch.StartNew();
            owner = AwaitOwner(pipeName, RemainingHandshake(handshakeTimeoutMs, () => handshakeClock.ElapsedMilliseconds));
            ownerReader = new StreamReader(owner, new UTF8Encoding(false), false, 1024, true);
            ownerWriter = new StreamWriter(owner, new UTF8Encoding(false), 1024, true);
            ownerWriter.AutoFlush = true;

            AuthenticateOwner(remaining => ReadLineBounded(ownerReader, remaining),
                () => handshakeClock.ElapsedMilliseconds, handshakeTimeoutMs, token);

            Thread ownerMonitor = new Thread(delegate()
            {
                try
                {
                    for (;;)
                    {
                        string line = ownerReader.ReadLine();
                        if (line == null) { volatileOwnerGone = true; return; }
                        if (FixedEquals(line, "CANCEL " + token)) volatileCancel = true;
                    }
                }
                catch { volatileOwnerGone = true; }
            });
            ownerMonitor.IsBackground = true;
            ownerMonitor.Start();

            RemainingHandshake(handshakeTimeoutMs, () => handshakeClock.ElapsedMilliseconds);
            // This closes the observed prelaunch window. Flags may still
            // change after this check; the postlaunch containment loop remains.
            CheckOwnerBeforeLaunch(volatileCancel, volatileOwnerGone);
            state = Launch(command, arguments, workingDirectory, verbatimArguments);
            long wrapperTicks = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks;
            ownerWriter.WriteLine("READY " + Process.GetCurrentProcess().Id + " " + wrapperTicks
                + " " + state.RootPid + " " + state.RootStartTicks);
            RootSignalWait rootSignalWait = new RootSignalWait(cleanupTimeoutMs);
            Stopwatch completionClock = Stopwatch.StartNew();
            controls = new ControlListener(pipeName);

            for (;;)
            {
                if (volatileCancel || volatileOwnerGone)
                {
                    if (!TerminateJobObject(state.Job, (uint)TERMINATED_EXIT) && ActiveProcesses(state.Job) != 0)
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "The owned Job Object could not be terminated.");
                    if (!WaitForZero(state.Job, cleanupTimeoutMs))
                        throw new TimeoutException("The owned Job Object did not reach zero active processes after cancellation.");
                    if (!volatileOwnerGone) ownerWriter.WriteLine("TERMINATED " + TERMINATED_EXIT + " 0");
                    return TERMINATED_EXIT;
                }

                // A provider CLI is the authority for every tool process it
                // launched. If that root exits first, its descendants are no
                // longer useful work and a PID-tree walk has already lost the
                // relationship Windows just severed. The retained Job Object
                // still owns the exact processes, so terminate them here and
                // report the root's real exit code after proving the job empty.
                if (terminateDescendantsOnRootExit)
                {
                    uint rootWait = WaitForSingleObject(state.RootProcess, 0);
                    if (rootWait == WAIT_FAILED)
                        throw new RootWaitException("The contained root exit state could not be measured.",
                            rootWait, unchecked((uint)Marshal.GetLastWin32Error()));
                    if (rootWait != WAIT_OBJECT_0 && rootWait != WAIT_TIMEOUT)
                        throw new RootWaitException("The retained root wait returned an unexpected result.", rootWait, 0);
                    if (rootWait == WAIT_OBJECT_0)
                    {
                        int exitCode = ReadSignalledRootExitCode(state);
                        if (ActiveProcesses(state.Job) != 0)
                        {
                            if (!TerminateJobObject(state.Job, (uint)TERMINATED_EXIT) && ActiveProcesses(state.Job) != 0)
                                throw new Win32Exception(Marshal.GetLastWin32Error(), "The root exited but its remaining descendants could not be terminated.");
                            if (!WaitForZero(state.Job, cleanupTimeoutMs))
                                throw new TimeoutException("The root exited but its descendant job did not reach zero active processes.");
                        }
                        if (ActiveProcesses(state.Job) == 0)
                        {
                            ownerWriter.WriteLine("EXIT " + exitCode + " 0");
                            return exitCode;
                        }
                    }
                }

                if (ActiveProcesses(state.Job) == 0)
                {
                    uint rootWait = WaitForSingleObject(state.RootProcess, 0);
                    uint nativeError = rootWait == WAIT_FAILED ? unchecked((uint)Marshal.GetLastWin32Error()) : 0;
                    if (rootSignalWait.Observe(rootWait, nativeError, completionClock.ElapsedMilliseconds))
                    {
                        int exitCode = ReadSignalledRootExitCode(state);
                        if (ActiveProcesses(state.Job) == 0)
                        {
                            ownerWriter.WriteLine("EXIT " + exitCode + " 0");
                            return exitCode;
                        }
                    }
                    // Do not continue or block here: the control poll below
                    // and the cancellation check at the top stay responsive.
                }

                NamedPipeServerStream control = null;
                try
                {
                    control = controls.Poll(25);
                    if (control == null) continue;
                    using (StreamReader reader = new StreamReader(control, new UTF8Encoding(false), false, 1024, true))
                    using (StreamWriter writer = new StreamWriter(control, new UTF8Encoding(false), 1024, true))
                    {
                        writer.AutoFlush = true;
                        string request = ReadLineBounded(reader, 1000);
                        if (!ValidTermination(request, token, wrapperTicks, state))
                        {
                            writer.WriteLine(ErrorLine("WINDOWS_JOB_IDENTITY_MISMATCH",
                                new InvalidOperationException("The control request did not match the retained wrapper/root creation identities.")));
                            continue;
                        }
                        if (!TerminateJobObject(state.Job, (uint)TERMINATED_EXIT) && ActiveProcesses(state.Job) != 0)
                            throw new Win32Exception(Marshal.GetLastWin32Error(), "The owned Job Object could not be terminated.");
                        if (!WaitForZero(state.Job, cleanupTimeoutMs))
                            throw new TimeoutException("The owned Job Object did not reach zero active processes after termination.");
                        writer.WriteLine("TERMINATED " + TERMINATED_EXIT + " 0");
                        ownerWriter.WriteLine("TERMINATED " + TERMINATED_EXIT + " 0");
                        return TERMINATED_EXIT;
                    }
                }
                catch (IOException) { /* a probing client vanished; ownership is unchanged */ }
                catch (TimeoutException) { /* a client connected without a bounded request */ }
                finally { if (control != null) control.Dispose(); }
            }
        }
        catch (Exception error)
        {
            try
            {
                if (ownerWriter != null && !volatileOwnerGone)
                    ownerWriter.WriteLine(ErrorLine(error is ChildSpawnException
                        ? "WINDOWS_JOB_CHILD_SPAWN_FAILED"
                        : error is HandshakeDeadlineException ? "WINDOWS_JOB_HANDSHAKE_DEADLINE"
                        : error is OperationCanceledException ? "WINDOWS_JOB_LAUNCH_CANCELLED"
                        : "WINDOWS_JOB_WRAPPER_FAILED", error));
            }
            catch { }
            return WRAPPER_FAILURE_EXIT;
        }
        finally
        {
            if (controls != null) controls.Dispose();
            if (state != null)
            {
                // If any failure bypassed the explicit zero proof, closing this
                // handle is the kernel-enforced final containment boundary.
                Close(ref state.RootThread);
                Close(ref state.RootProcess);
                Close(ref state.Job);
            }
            if (ownerWriter != null) ownerWriter.Dispose();
            if (ownerReader != null) ownerReader.Dispose();
            if (owner != null) owner.Dispose();
        }
    }

    // Static fields are used only as cross-thread cancellation flags inside one
    // short-lived wrapper process (there is exactly one Run invocation).
    private static volatile bool volatileOwnerGone;
    private static volatile bool volatileCancel;
}
// Appended to the retained Job wrapper compilation. No WSL, shell expansion,
// global policy or account creation. The unique restricting SID has no login.
public sealed class FleetWindowsFolderScope : System.IDisposable
{
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES { public System.IntPtr Sid; public uint Attributes; }
    [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError=true)]
    private static extern bool OpenProcessToken(System.IntPtr process, uint access, out System.IntPtr token);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern System.IntPtr GetCurrentProcess();
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool CloseHandle(System.IntPtr handle);
    [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError=true)]
    private static extern bool CreateRestrictedToken(System.IntPtr existing, uint flags, uint disabledCount,
        System.IntPtr disabled, uint privilegeCount, System.IntPtr privileges, uint restrictedCount,
        ref SID_AND_ATTRIBUTES restricted, out System.IntPtr token);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
    private static extern System.IntPtr CreateFileW(string path,uint access,uint share,System.IntPtr security,uint creation,uint flags,System.IntPtr template);
    private readonly System.Collections.Generic.Dictionary<string,System.IntPtr> locks = new System.Collections.Generic.Dictionary<string,System.IntPtr>(System.StringComparer.OrdinalIgnoreCase);
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES { public int Length; public System.IntPtr Descriptor; public int Inherit; }
    [System.Runtime.InteropServices.DllImport("advapi32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode,SetLastError=true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint revision,out System.IntPtr descriptor,out uint size);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern System.IntPtr LocalFree(System.IntPtr pointer);
    [System.Runtime.InteropServices.DllImport("user32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode,SetLastError=true)]
    private static extern System.IntPtr CreateWindowStationW(string name,uint flags,uint access,ref SECURITY_ATTRIBUTES attributes);
    [System.Runtime.InteropServices.DllImport("user32.dll",SetLastError=true)] private static extern bool SetProcessWindowStation(System.IntPtr station);
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern System.IntPtr GetProcessWindowStation();
    [System.Runtime.InteropServices.DllImport("user32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode,SetLastError=true)]
    private static extern System.IntPtr CreateDesktopW(string name,string device,System.IntPtr mode,uint flags,uint access,ref SECURITY_ATTRIBUTES attributes);
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool CloseDesktop(System.IntPtr desktop);
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern bool CloseWindowStation(System.IntPtr station);
    private System.IntPtr stationHandle, desktopHandle;
    public string DesktopName { get; private set; }
    private void PreparePrivateDesktop()
    {
        string name="fleetV2-"+System.Guid.NewGuid().ToString("N");
        string user=System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
        string sddl="D:(A;;GA;;;SY)(A;;GA;;;"+user+")(A;;GA;;;"+sid.Value+")";
        System.IntPtr descriptor; uint size;
        if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,out descriptor,out size))
            throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
        var attributes=new SECURITY_ATTRIBUTES();attributes.Length=System.Runtime.InteropServices.Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));attributes.Descriptor=descriptor;
        var original=GetProcessWindowStation();
        try {
            stationHandle=CreateWindowStationW(name,0,0x000f037f,ref attributes);
            if(stationHandle==System.IntPtr.Zero || !SetProcessWindowStation(stationHandle))
                throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            desktopHandle=CreateDesktopW("default",null,System.IntPtr.Zero,0,0x10000000,ref attributes);
            if(desktopHandle==System.IntPtr.Zero)throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            DesktopName=name+"\\default";
        } finally { SetProcessWindowStation(original);LocalFree(descriptor); }
    }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct TOKEN_DEFAULT_DACL { public System.IntPtr Dacl; }
    [System.Runtime.InteropServices.DllImport("advapi32.dll",SetLastError=true)]
    private static extern bool GetTokenInformation(System.IntPtr token,int kind,System.IntPtr buffer,int length,out int needed);
    [System.Runtime.InteropServices.DllImport("advapi32.dll",SetLastError=true)]
    private static extern bool SetTokenInformation(System.IntPtr token,int kind,ref TOKEN_DEFAULT_DACL info,int length);
    private void PrepareDefaultDacl()
    {
        int needed;GetTokenInformation(Token,6,System.IntPtr.Zero,0,out needed);
        var data=System.Runtime.InteropServices.Marshal.AllocHGlobal(needed);
        System.IntPtr memory=System.IntPtr.Zero;
        try {
            if(!GetTokenInformation(Token,6,data,needed,out needed))throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            var pointer=System.Runtime.InteropServices.Marshal.ReadIntPtr(data);
            System.Security.AccessControl.RawAcl acl;
            if(pointer==System.IntPtr.Zero) acl=new System.Security.AccessControl.RawAcl(2,1);
            else {
                int size=(ushort)System.Runtime.InteropServices.Marshal.ReadInt16(pointer,2);
                byte[] bytes=new byte[size];System.Runtime.InteropServices.Marshal.Copy(pointer,bytes,0,size);
                acl=new System.Security.AccessControl.RawAcl(bytes,0);
            }
            acl.InsertAce(acl.Count,new System.Security.AccessControl.CommonAce(System.Security.AccessControl.AceFlags.None,
                System.Security.AccessControl.AceQualifier.AccessAllowed,0x10000000,sid,false,null));
            byte[] encoded=new byte[acl.BinaryLength];acl.GetBinaryForm(encoded,0);
            memory=System.Runtime.InteropServices.Marshal.AllocHGlobal(encoded.Length);
            System.Runtime.InteropServices.Marshal.Copy(encoded,0,memory,encoded.Length);
            var info=new TOKEN_DEFAULT_DACL();info.Dacl=memory;
            if(!SetTokenInformation(Token,6,ref info,System.IntPtr.Size))throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
        } finally {
            System.Runtime.InteropServices.Marshal.FreeHGlobal(data);
            if(memory!=System.IntPtr.Zero)System.Runtime.InteropServices.Marshal.FreeHGlobal(memory);
        }
    }
    private readonly System.Security.Principal.SecurityIdentifier sid;
    private readonly System.Collections.Generic.List<string> grants = new System.Collections.Generic.List<string>();
    public System.IntPtr Token { get; private set; }
    public FleetWindowsFolderScope(string[] reads, string[] writes, bool readAll)
    {
        byte[] random = new byte[16];
        using (var rng = System.Security.Cryptography.RandomNumberGenerator.Create()) rng.GetBytes(random);
        sid = new System.Security.Principal.SecurityIdentifier("S-1-5-21-" +
            (System.BitConverter.ToUInt32(random,0) & 0x7fffffff) + "-" +
            (System.BitConverter.ToUInt32(random,4) & 0x7fffffff) + "-" +
            (System.BitConverter.ToUInt32(random,8) & 0x7fffffff) + "-" +
            (System.BitConverter.ToUInt32(random,12) & 0x7fffffff));
        System.IntPtr original=System.IntPtr.Zero, sidBytes=System.IntPtr.Zero;
        try {
            foreach (string root in reads) if (!readAll) Grant(root, System.Security.AccessControl.FileSystemRights.ReadAndExecute);
            foreach (string root in writes) Grant(root,
                System.Security.AccessControl.FileSystemRights.Write |
                System.Security.AccessControl.FileSystemRights.Delete |
                System.Security.AccessControl.FileSystemRights.DeleteSubdirectoriesAndFiles |
                System.Security.AccessControl.FileSystemRights.ReadPermissions |
                System.Security.AccessControl.FileSystemRights.Synchronize);
            if (!OpenProcessToken(GetCurrentProcess(), 0x008b, out original))
                throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes,0);
            sidBytes=System.Runtime.InteropServices.Marshal.AllocHGlobal(bytes.Length);
            System.Runtime.InteropServices.Marshal.Copy(bytes,0,sidBytes,bytes.Length);
            SID_AND_ATTRIBUTES item=new SID_AND_ATTRIBUTES(); item.Sid=sidBytes;
            System.IntPtr token;
            // WRITE_RESTRICTED limits the restricting-SID check to writes.
            // This is allowed only by the explicit parent readAll flag.
            if (!CreateRestrictedToken(original, readAll ? 9u : 1u, 0, System.IntPtr.Zero,
                    0, System.IntPtr.Zero, 1, ref item, out token))
                throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            Token=token;
            PrepareDefaultDacl();
            PreparePrivateDesktop();
        } catch { Dispose(); throw; }
        finally {
            if (original!=System.IntPtr.Zero) CloseHandle(original);
            if (sidBytes!=System.IntPtr.Zero) System.Runtime.InteropServices.Marshal.FreeHGlobal(sidBytes);
        }
    }
    private void ValidatePhysical(string root)
    {
        if (string.IsNullOrEmpty(root) || !System.IO.Path.IsPathRooted(root)
                || !string.Equals(System.IO.Path.GetFullPath(root).TrimEnd('\\'),root.TrimEnd('\\'),System.StringComparison.OrdinalIgnoreCase))
            throw new System.ArgumentException("Native folder scope requires physical absolute paths.");
        var parts=new System.Collections.Generic.Stack<string>();
        string current=root;
        for (;;) {
            parts.Push(current);
            var parent=System.IO.Directory.GetParent(current);
            if (parent==null || string.Equals(parent.FullName,current,System.StringComparison.OrdinalIgnoreCase)) break;
            current=parent.FullName;
        }
        while(parts.Count>0) {
            current=parts.Pop();
            if(!locks.ContainsKey(current)) {
                // Retain each ancestor without FILE_SHARE_DELETE. Root/ancestor
                // replacement cannot redirect path-based DACL updates.
                var handle=CreateFileW(current,0,3,System.IntPtr.Zero,3,0x02200000,System.IntPtr.Zero);
                if(handle==new System.IntPtr(-1)) throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
                locks.Add(current,handle);
            }
            if ((System.IO.File.GetAttributes(current) & System.IO.FileAttributes.ReparsePoint)!=0)
                throw new System.IO.IOException("Native folder scope refuses reparse-point roots.");
        }
    }
    private void Grant(string root, System.Security.AccessControl.FileSystemRights rights)
    {
        ValidatePhysical(root);
        bool directory=System.IO.Directory.Exists(root);
        var inheritance=directory ? System.Security.AccessControl.InheritanceFlags.ContainerInherit |
            System.Security.AccessControl.InheritanceFlags.ObjectInherit : System.Security.AccessControl.InheritanceFlags.None;
        System.Security.AccessControl.FileSystemSecurity acl=directory
            ? (System.Security.AccessControl.FileSystemSecurity)System.IO.Directory.GetAccessControl(root)
            : System.IO.File.GetAccessControl(root);
        var rule=new System.Security.AccessControl.FileSystemAccessRule(sid,rights,inheritance,
            System.Security.AccessControl.PropagationFlags.None,System.Security.AccessControl.AccessControlType.Allow);
        acl.AddAccessRule(rule);
        // Add before mutation so even an ambiguous SetAccessControl failure
        // preserves cleanup custody. Never restore a stale whole DACL.
        grants.Add(root);
        if (directory) System.IO.Directory.SetAccessControl(root,(System.Security.AccessControl.DirectorySecurity)acl);
        else System.IO.File.SetAccessControl(root,(System.Security.AccessControl.FileSecurity)acl);
        // Protected descendants do not inherit; refuse instead of silently
        // giving a worker less effective scope than its parent.
        if (directory) {
            var pending=new System.Collections.Generic.Stack<string>(); pending.Push(root);
            while(pending.Count>0) foreach(string entry in System.IO.Directory.GetFileSystemEntries(pending.Pop())) {
                var attrs=System.IO.File.GetAttributes(entry);
                if ((attrs & System.IO.FileAttributes.ReparsePoint)!=0) continue; // target gets no new grant
                bool subdir=(attrs & System.IO.FileAttributes.Directory)!=0;
                var childAcl=subdir ? (System.Security.AccessControl.FileSystemSecurity)System.IO.Directory.GetAccessControl(entry)
                    : System.IO.File.GetAccessControl(entry);
                if (childAcl.AreAccessRulesProtected)
                    throw new System.UnauthorizedAccessException("A protected descendant DACL cannot inherit the exact folder grant.");
                if(subdir) pending.Push(entry);
            }
        }
    }
    public void Dispose()
    {
        if(Token!=System.IntPtr.Zero) { CloseHandle(Token); Token=System.IntPtr.Zero; }
        if(desktopHandle!=System.IntPtr.Zero) { CloseDesktop(desktopHandle); desktopHandle=System.IntPtr.Zero; }
        if(stationHandle!=System.IntPtr.Zero) { CloseWindowStation(stationHandle); stationHandle=System.IntPtr.Zero; }
        System.Exception failed=null;
        for(int i=grants.Count-1;i>=0;i--) {
            string root=grants[i];
            try {
                bool directory=System.IO.Directory.Exists(root);
                var acl=directory ? (System.Security.AccessControl.FileSystemSecurity)System.IO.Directory.GetAccessControl(root)
                    : System.IO.File.GetAccessControl(root);
                var rules=acl.GetAccessRules(true,false,typeof(System.Security.Principal.SecurityIdentifier));
                foreach(System.Security.AccessControl.FileSystemAccessRule rule in rules)
                    if(rule.IdentityReference.Equals(sid)) acl.RemoveAccessRuleSpecific(rule);
                if(directory) System.IO.Directory.SetAccessControl(root,(System.Security.AccessControl.DirectorySecurity)acl);
                else System.IO.File.SetAccessControl(root,(System.Security.AccessControl.FileSecurity)acl);
            } catch(System.Exception error) { failed=error; }
        }
        grants.Clear();
        foreach(var handle in locks.Values) CloseHandle(handle);
        locks.Clear();
        if(failed!=null) throw new System.IO.IOException("Scoped folder ACE cleanup could not be confirmed.",failed);
    }
}

'@

# CACHING. See the -AssemblyCacheDirectoryBase64 parameter comment above.
#
# $source above is fully static: byte-identical on every invocation of this
# exact file. Add-Type -TypeDefinition recompiles it from scratch in a fresh
# csc.exe every time -- Windows PowerShell keeps no cross-process compile
# cache -- so that compile (~840 ms measured average: 929/768/938/860/722 ms
# across 5 fresh-process runs on this machine) was paid again on EVERY SINGLE
# host.exec call, for output that can only ever be the same assembly.
# Add-Type -Path, loading an already-compiled copy of the identical type,
# averages ~240 ms (296/189/311/199/146/302 ms across 6 runs) -- roughly a
# 600 ms saving per call, forever, for zero behavior change: it is the exact
# same compiled code either way, just not re-derived from source each time.
#
# Every step below is best-effort. A cache directory that is missing,
# unwritable, unreadable, or holds a corrupt entry must read as a miss and
# fall through to the original unconditional compile -- caching a
# security-relevant process-containment wrapper must never make it LESS
# reliable than not caching at all.
function Install-WrapperType {
  param([string]$Source, [string]$CacheDirectoryBase64)

  $cacheDirectory = $null
  if ($CacheDirectoryBase64) {
    try { $cacheDirectory = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CacheDirectoryBase64)) }
    catch { $cacheDirectory = $null }
  }
  if (-not $cacheDirectory) {
    Add-Type -TypeDefinition $Source -Language CSharp -ErrorAction Stop
    return
  }

  $cacheFile = $null
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try { $hashBytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Source)) }
    finally { $sha256.Dispose() }
    $hashHex = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
    $null = New-Item -ItemType Directory -Force -Path $cacheDirectory -ErrorAction Stop
    $cacheFile = Join-Path $cacheDirectory ('wrapper-' + $hashHex + '.dll')
  } catch {
    # The directory could not be created, or the source could not be
    # hashed. No cache file identity exists to try, so compile exactly as
    # if no cache directory had been configured at all.
    Add-Type -TypeDefinition $Source -Language CSharp -ErrorAction Stop
    return
  }

  if (Test-Path -LiteralPath $cacheFile) {
    try {
      Add-Type -Path $cacheFile -ErrorAction Stop
      return
    } catch {
      # A present-but-broken cache entry (partial write from a killed
      # process, wrong CLR, hand-edited) reads as a miss, not a failure --
      # fall through to the compile-and-seed path below.
    }
  }

  # MUST end in .dll, not .tmp: Add-Type -Path inspects the file extension to
  # decide how to interpret the file and rejects anything it does not
  # recognize -- MEASURED directly (debug-outputassembly-step.ps1): a
  # byte-identical assembly named *.tmp fails Add-Type -Path with "Cannot add
  # type. The '.TMP' extension is not supported.", which silently discarded
  # every cache write on this exact path (the surrounding catch below treated
  # that as an ordinary miss and recompiled, so the command still ran
  # correctly -- only caching itself was dead, invisibly, on every call).
  $tempFile = Join-Path $cacheDirectory ('wrapper-' + $hashHex + '.' + $PID + '.' + [System.Guid]::NewGuid().ToString('N') + '.dll')
  try {
    # -OutputAssembly compiles AND writes the DLL to $tempFile, but (measured
    # above, test-outputassembly.ps1) does NOT load the type into this
    # session by itself -- the explicit -Path load below is required either
    # way, so this path costs one compile plus one cheap load, same as an
    # ordinary -TypeDefinition compile, while also seeding the cache.
    Add-Type -TypeDefinition $Source -Language CSharp -OutputAssembly $tempFile -ErrorAction Stop
    Add-Type -Path $tempFile -ErrorAction Stop
  } catch {
    # The temp-compile-and-load path failed for a reason unrelated to
    # $Source itself being uncompilable (disk full, a locked temp name, a
    # path-length limit) -- that path shares no failure mode with the plain
    # compile below, so fall all the way back to it rather than surfacing
    # what would be a spurious caching-only failure.
    try { if (Test-Path -LiteralPath $tempFile) { Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue } } catch {}
    Add-Type -TypeDefinition $Source -Language CSharp -ErrorAction Stop
    return
  }
  try {
    # Content-addressed by $hashHex, so whichever concurrent writer's file
    # lands first is byte-for-byte interchangeable with this one; losing the
    # race costs nothing more than the redundant temp file cleaned up below.
    if (-not (Test-Path -LiteralPath $cacheFile)) {
      Move-Item -LiteralPath $tempFile -Destination $cacheFile -ErrorAction Stop
    }
  } catch {
    # The type is already loaded in THIS process from the temp copy above,
    # so the current command is unaffected; only the on-disk seed was
    # skipped, and the next miss will simply try again.
  } finally {
    try { if (Test-Path -LiteralPath $tempFile) { Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue } } catch {}
  }
}

try {
  Install-WrapperType -Source $source -CacheDirectoryBase64 $AssemblyCacheDirectoryBase64
  $utf8 = [System.Text.Encoding]::UTF8
  $command = $utf8.GetString([Convert]::FromBase64String($CommandBase64))
  $workingDirectory = $utf8.GetString([Convert]::FromBase64String($WorkingDirectoryBase64))
  $argumentJson = $utf8.GetString([Convert]::FromBase64String($ArgumentsBase64))
  $parsed = ConvertFrom-Json -InputObject $argumentJson
  [string[]]$childArguments = @($parsed | ForEach-Object { [string]$_ })
  if ($FolderScopeBase64) {
    $scope = ConvertFrom-Json -InputObject $utf8.GetString([Convert]::FromBase64String($FolderScopeBase64))
    [string[]]$reads = @($scope.readRoots | ForEach-Object { [string]$_ })
    [string[]]$writes = @($scope.writeRoots | ForEach-Object { [string]$_ })
    $result = [ToolsEnabledWindowsJobWrapper]::RunWithFolderScope($PipeName,$Token,$command,$childArguments,
      $workingDirectory,$CleanupTimeoutMs,$HandshakeTimeoutMs,[bool]$TerminateDescendantsOnRootExit,[bool]$VerbatimArguments,
      $reads,$writes,($scope.readAll -eq $true))
  } else {
  $result = [ToolsEnabledWindowsJobWrapper]::Run(
    $PipeName,
    $Token,
    $command,
    $childArguments,
    $workingDirectory,
    $CleanupTimeoutMs,
    $HandshakeTimeoutMs,
    [bool]$TerminateDescendantsOnRootExit,
    [bool]$VerbatimArguments
  )
  }
  exit $result
} catch {
  # Add-Type/argument decoding can fail before the trusted wrapper owns a pipe.
  # The Node parent treats any pre-READY exit as a launch refusal.
  exit 250
}

param([Parameter(Mandatory=$true)][int]$StartPid)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {
Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;using System.Security.Principal;
public static class TeaaOwnProcesses {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ENTRY {public uint size,usage,pid;public IntPtr heap;public uint module,threads,parent;public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string exe;}
 [StructLayout(LayoutKind.Sequential)] struct UNICODE {public ushort length,max;public IntPtr buffer;}
 [DllImport("kernel32.dll")]static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32FirstW(IntPtr s,ref ENTRY e);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32NextW(IntPtr s,ref ENTRY e);
 [DllImport("kernel32.dll")]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")]static extern bool GetProcessTimes(IntPtr h,out long create,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool QueryFullProcessImageNameW(IntPtr h,uint flags,StringBuilder name,ref uint length);
 [DllImport("advapi32.dll")]static extern bool OpenProcessToken(IntPtr h,uint access,out IntPtr t);
 [DllImport("advapi32.dll")]static extern bool GetTokenInformation(IntPtr h,int kind,IntPtr value,uint length,out uint used);
 [DllImport("ntdll.dll")]static extern int NtQueryInformationProcess(IntPtr h,int kind,IntPtr value,int length,out int used);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)]static extern IntPtr CommandLineToArgvW(string text,out int count);
 [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr p);
 public class Row {public int pid,ppid;public string executable,startTime;public string[] argv;}
 public static Row[] Read(int start) {
  if(start<2)throw new Exception();var parents=new Dictionary<uint,uint>();IntPtr snap=CreateToolhelp32Snapshot(2,0);if(snap==new IntPtr(-1))throw new Exception();
  try{ENTRY e=new ENTRY();e.size=(uint)Marshal.SizeOf(e);if(!Process32FirstW(snap,ref e))throw new Exception();do{parents[e.pid]=e.parent;}while(Process32NextW(snap,ref e));}finally{CloseHandle(snap);}
  var rows=new List<Row>();string owner=WindowsIdentity.GetCurrent().User.Value;uint cursor=(uint)start;long bound=long.MaxValue;var seen=new HashSet<uint>();
  while(cursor>1 && rows.Count<16 && seen.Add(cursor)){
   uint parent;if(!parents.TryGetValue(cursor,out parent))break;IntPtr h=OpenProcess(0x1000,false,cursor);if(h==IntPtr.Zero)break;
   try{long created,ex,k,u;if(!GetProcessTimes(h,out created,out ex,out k,out u)||created>bound||ex!=0)break;
    IntPtr t;if(!OpenProcessToken(h,8,out t))break;string sid;try{uint used;GetTokenInformation(t,1,IntPtr.Zero,0,out used);if(used>65536||used<8)throw new Exception();IntPtr p=Marshal.AllocHGlobal((int)used);try{if(!GetTokenInformation(t,1,p,used,out used))throw new Exception();sid=new SecurityIdentifier(Marshal.ReadIntPtr(p)).Value;}finally{Marshal.FreeHGlobal(p);}}finally{CloseHandle(t);}if(sid!=owner)break;
    uint len=32768;var name=new StringBuilder((int)len);if(!QueryFullProcessImageNameW(h,0,name,ref len))break;
    int needed;NtQueryInformationProcess(h,60,IntPtr.Zero,0,out needed);if(needed<8||needed>131072)break;IntPtr info=Marshal.AllocHGlobal(needed);string text;try{if(NtQueryInformationProcess(h,60,info,needed,out needed)<0)break;UNICODE value=(UNICODE)Marshal.PtrToStructure(info,typeof(UNICODE));long low=info.ToInt64(),high=low+needed;if(value.length%2!=0||value.buffer.ToInt64()<low||value.buffer.ToInt64()+value.length>high)throw new Exception();text=Marshal.PtrToStringUni(value.buffer,value.length/2);}finally{Marshal.FreeHGlobal(info);}
    int count;IntPtr args=CommandLineToArgvW(text,out count);if(args==IntPtr.Zero||count<1||count>4096)throw new Exception();string[] words=new string[count];try{for(int i=0;i<count;i++)words[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(args,i*IntPtr.Size));}finally{LocalFree(args);}
    rows.Add(new Row{pid=(int)cursor,ppid=(int)parent,executable=name.ToString(),startTime="win32:"+created,argv=words});bound=created;cursor=parent;
   }finally{CloseHandle(h);}
  }
  if(rows.Count==0)throw new Exception();return rows.ToArray();
 }
}
'@
$rows=[TeaaOwnProcesses]::Read($StartPid)
[Console]::WriteLine((ConvertTo-Json -InputObject @($rows) -Depth 5 -Compress))
} catch { [Console]::WriteLine('[]');exit 1 }

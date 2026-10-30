using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// No path-string inference stands in for querying the opened directory volume.
public static class ToolsEngineInstallerVolume {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern bool MoveFileExW(string source,string destination,uint flags);
  public static void PublishFile(string source,string destination) {
    // Same-directory publication only, enforced by the calling path validator.
    // No cross-volume copy or delayed reboot operation is enabled.
    // Even delete-sharing readers can transiently block replacement on NTFS.
    // Wait for those readers without changing the file ACL or publication
    // operation. Persistent access denials still fail within a bounded window.
    var deadline=System.Diagnostics.Stopwatch.StartNew();
    while(!MoveFileExW(source,destination,0x1|0x8)) {
      int error=Marshal.GetLastWin32Error();
      if((error!=5&&error!=32)||deadline.ElapsedMilliseconds>=2000)
        throw new InvalidOperationException("The private state file could not be published.");
      System.Threading.Thread.Sleep(20);
    }
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Information {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;
    public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern uint GetDriveTypeW(string root);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Information information);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern uint GetFileType(SafeFileHandle handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle,StringBuilder volumeName,uint volumeSize,IntPtr serial,IntPtr maximumComponent,IntPtr flags,StringBuilder fileSystem,uint fileSystemSize);
  public sealed class Volume { public string FileSystem; public bool FixedDrive; }
  public static void RequireFixedDrive(uint driveType) {
    if(driveType!=3)throw new InvalidOperationException("A fixed local NTFS drive is required.");
  }
  public static void RequireNtfs(bool queried,string fileSystem) {
    if(!queried||!String.Equals(fileSystem,"NTFS",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("The opened directory must be on local NTFS.");
  }
  public static Volume InspectDirectory(string path) {
    RequireFixedDrive(GetDriveTypeW(Path.GetPathRoot(path)));
    // FILE_READ_ATTRIBUTES; OPEN_REPARSE_POINT and BACKUP_SEMANTICS.
    using(SafeFileHandle handle=CreateFileW(path,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      if(handle.IsInvalid||GetFileType(handle)!=1)throw new InvalidOperationException("The directory volume could not be verified.");
      Information info;
      if(!GetFileInformationByHandle(handle,out info)||(info.Attributes&0x10)==0||(info.Attributes&0x400)!=0)throw new InvalidOperationException("A plain directory handle is required.");
      StringBuilder fileSystem=new StringBuilder(32);
      bool queried=GetVolumeInformationByHandleW(handle,null,0,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,fileSystem,(uint)fileSystem.Capacity);
      RequireNtfs(queried,fileSystem.ToString());
      return new Volume {FileSystem="NTFS",FixedDrive=true};
    }
  }
}

# Adds Jarvis to the Desktop and the Start Menu, and starts it with Windows. Run once:
#     powershell -ExecutionPolicy Bypass -File install_jarvis.ps1
# The icons point at this folder, so keep it where it is, or run this again after moving it.
$root = $PSScriptRoot
$pythonw = Join-Path $root ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $pythonw)) { throw "Set up .venv first: $pythonw is missing." }

# The same ID the running app gives itself in Jarvis.pyw. It keeps the window under a pinned taskbar icon,
# rather than opening a second one. Windows only lets this be set through its COM interface.
Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;
public static class ShortcutId {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink {}
    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPersistFile {
        void GetClassID(out Guid id); [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string file, int mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string file, bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string file);
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PropertyKey { public Guid Format; public int Id; }
    [StructLayout(LayoutKind.Explicit)] struct PropVariant {
        [FieldOffset(0)] public short Type;
        [FieldOffset(8)] public IntPtr Text;
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }
    public static void Set(string path, string id) {
        object link = new ShellLink();
        ((IPersistFile)link).Load(path, 2);
        var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
        var value = new PropVariant { Type = 31, Text = Marshal.StringToCoTaskMemUni(id) };
        var store = (IPropertyStore)link;
        store.SetValue(ref key, ref value);
        store.Commit();
        ((IPersistFile)link).Save(path, true);
        Marshal.FreeCoTaskMem(value.Text);
    }
}
"@

$shell = New-Object -ComObject WScript.Shell
# Startup makes Jarvis open when Windows starts, so "Hey Jarvis" always works while the laptop is on.
foreach ($folder in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Startup"))) {
    $path = Join-Path $folder "Jarvis.lnk"
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $pythonw
    $shortcut.Arguments = '"' + (Join-Path $root "Jarvis.pyw") + '"'
    # At startup it opens on the wallpaper and by the clock, without its window.
    if ($folder -eq [Environment]::GetFolderPath("Startup")) { $shortcut.Arguments += " --background" }
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = Join-Path $root "Frontend\jarvis.ico"
    $shortcut.Description = "J.A.R.V.I.S."
    $shortcut.Save()
    [ShortcutId]::Set($path, "Ushnish.Jarvis")
    Write-Output "Added: $path"
}

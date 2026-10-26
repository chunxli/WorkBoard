using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class WorkBoardNotificationShortcut
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLink
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr findData, uint flags);
        void GetIDList(out IntPtr list);
        void SetIDList(IntPtr list);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int count);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int count);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int count);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int show);
        void SetShowCmd(int show);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder icon, int count, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid Format;
        public uint Id;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropertyVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Value;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropertyVariant value);
        void SetValue(ref PropertyKey key, ref PropertyVariant value);
        void Commit();
    }

    public static void Create(string file, string executable, string arguments, string appId, string icon, string activator)
    {
        object instance = new ShellLink();
        IntPtr appIdValue = IntPtr.Zero;
        IntPtr activatorValue = IntPtr.Zero;
        try
        {
            IShellLink link = (IShellLink)instance;
            link.SetPath(executable);
            link.SetArguments(arguments);
            link.SetDescription("Work Board");
            link.SetIconLocation(icon, 0);
            link.SetShowCmd(1);
            IPropertyStore store = (IPropertyStore)instance;
            Guid format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
            PropertyKey appIdKey = new PropertyKey { Format = format, Id = 5 };
            appIdValue = Marshal.StringToCoTaskMemUni(appId);
            PropertyVariant appIdVariant = new PropertyVariant { Type = 31, Value = appIdValue };
            store.SetValue(ref appIdKey, ref appIdVariant);
            // Protocol activation needs an identity, not a running COM callback server.
            PropertyKey activatorKey = new PropertyKey { Format = format, Id = 26 };
            activatorValue = Marshal.AllocCoTaskMem(16);
            Marshal.StructureToPtr(new Guid(activator), activatorValue, false);
            PropertyVariant activatorVariant = new PropertyVariant { Type = 72, Value = activatorValue };
            store.SetValue(ref activatorKey, ref activatorVariant);
            store.Commit();
            ((IPersistFile)instance).Save(file, true);
        }
        finally
        {
            if (appIdValue != IntPtr.Zero) Marshal.FreeCoTaskMem(appIdValue);
            if (activatorValue != IntPtr.Zero) Marshal.FreeCoTaskMem(activatorValue);
            Marshal.FinalReleaseComObject(instance);
        }
    }
}

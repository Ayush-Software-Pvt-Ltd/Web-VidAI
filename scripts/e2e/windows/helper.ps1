# The Windows helper of the end-to-end runner (scripts/e2e/windows/platform.mjs).
#
# One long-lived Windows PowerShell process (started with -STA, which the clipboard needs) that
# answers JSON requests, one per line on stdin, with one JSON line on stdout:
#   {"id":1,"op":"windows","pid":1234}  ->  {"id":1,"ok":true,"value":[...]}
# The work is done by the C# class below, compiled once at start with the .NET Framework that
# every Windows has (no download, no extra tool). It only uses documented Win32 calls:
#
#   screen                      the primary screen: size, work area, DPI
#   setResolution w h           changes the primary display mode (CI runners start small)
#   windows pid [all]           top-level windows of a process (visible ones unless all)
#   capture hwnd file           only that window into a PNG (PrintWindow, else the screen)
#   foreground hwnd             makes it the foreground window
#   keys hwnd key mods          a real key press (SendInput) into the foreground window
#   drag hwnd from to           a real mouse drag (SendInput), from and to in screen pixels
#   click hwnd at button        a real click (SendInput) at a point of the client area (pixels)
#   close hwnd                  asks the window to close (WM_CLOSE), like its close button
#   clipboardSave / clipboardRestore / clipboardText
#   processes                   every process: pid, parent, name, command line, start time
#   watchStart / watchStop      records every top-level window shown in between (WinEvents)
#   cover hwnd / uncover        an opaque window of this process over that window, made the
#                               foreground window (as when the person works in another app)
#   start file cwd env timeout  starts a program from this process (the foreground process while
#                               the cover is in front, as Explorer is for a click in the Start
#                               menu) and waits for it to end
#
# The first line it prints is {"ready":true,...} with the screen.

$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class VidaiE2E
{
    // ------------------------------------------------------------------------------------------
    // Win32
    // ------------------------------------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint to, bool on);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern short VkKeyScan(char c);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, out RECT value, uint winIni);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE devmode);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettings(ref DEVMODE devmode, int flags);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr wParam, IntPtr lParam);

    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const uint PW_RENDERFULLCONTENT = 2;
    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 2;
    const uint MOUSEEVENTF_MOVE = 1, MOUSEEVENTF_LEFTDOWN = 2, MOUSEEVENTF_LEFTUP = 4, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12;
    const uint WM_CLOSE = 0x10, WM_QUIT = 0x12;
    const uint EVENT_OBJECT_SHOW = 0x8002;
    const uint GA_ROOT = 2, GW_OWNER = 4;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    // ------------------------------------------------------------------------------------------
    // The request loop
    // ------------------------------------------------------------------------------------------

    public static void Run()
    {
        // Physical pixels everywhere (per-monitor aware), like the app itself.
        bool aware = false;
        try { aware = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
        if (!aware) SetProcessDPIAware();
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        stdout.AutoFlush = true;
        var ready = new Dictionary<string, object> { { "ready", true }, { "screen", Screen0() } };
        stdout.WriteLine(Json.Serialize(ready));
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            object id = null;
            Dictionary<string, object> reply;
            try
            {
                var req = Json.Deserialize<Dictionary<string, object>>(line);
                id = req.ContainsKey("id") ? req["id"] : null;
                reply = new Dictionary<string, object> { { "id", id }, { "ok", true }, { "value", Dispatch(req) } };
            }
            catch (Exception e)
            {
                reply = new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", e.GetType().Name + ": " + e.Message } };
            }
            stdout.WriteLine(Json.Serialize(reply));
        }
        StopWatch();
        Uncover();
    }

    static object Dispatch(Dictionary<string, object> r)
    {
        switch ((string)r["op"])
        {
            case "screen": return Screen0();
            case "setResolution": return SetResolution(Int(r, "width"), Int(r, "height"));
            case "windows": return ListWindows(Int(r, "pid"), Bool(r, "all"));
            case "capture": return Capture(Hwnd(r), (string)r["file"]);
            case "foreground": return Focus(Hwnd(r));
            case "keys": return PressKey(Hwnd(r), (string)r["key"], Bool(r, "ctrl"), Bool(r, "shift"), Bool(r, "alt"));
            case "drag": return Drag(Hwnd(r), Ints(r, "from"), Ints(r, "to"));
            case "click": return Click(Hwnd(r), Ints(r, "at"), (string)r["button"]);
            case "wheel": return Wheel(Hwnd(r), Ints(r, "at"), Int(r, "delta"), Bool(r, "ctrl"));
            case "close": return PostMessage(Hwnd(r), WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            case "clipboardSave": return ClipboardSave();
            case "clipboardRestore": return ClipboardRestore();
            case "clipboardText": return Retry(() => Clipboard.ContainsText() ? Clipboard.GetText() : "");
            case "processes": return Processes();
            case "watchStart": return WatchStart();
            case "watchStop": return StopWatch();
            case "cover": return Cover(Hwnd(r));
            case "uncover": return Uncover();
            case "start": return Start((string)r["file"], (string)r["cwd"], (Dictionary<string, object>)r["env"], Int(r, "timeout"));
            default: throw new ArgumentException("unknown op " + r["op"]);
        }
    }

    static int Int(Dictionary<string, object> r, string key) { return Convert.ToInt32(r[key]); }
    static bool Bool(Dictionary<string, object> r, string key) { return r.ContainsKey(key) && r[key] is bool && (bool)r[key]; }
    static IntPtr Hwnd(Dictionary<string, object> r) { return new IntPtr(Convert.ToInt64(r["hwnd"])); }
    static int[] Ints(Dictionary<string, object> r, string key)
    {
        var list = (IList)r[key];
        var result = new int[list.Count];
        for (int i = 0; i < list.Count; i++) result[i] = Convert.ToInt32(list[i]);
        return result;
    }

    // ------------------------------------------------------------------------------------------
    // Screen and windows
    // ------------------------------------------------------------------------------------------

    /// The primary screen, asked of Windows each time (WinForms' Screen caches it until a
    /// display change message, which this process has no window to receive).
    static object Screen0()
    {
        RECT work;
        SystemParametersInfo(0x30, 0, out work, 0); // SPI_GETWORKAREA
        int dpi;
        using (var g = Graphics.FromHwnd(IntPtr.Zero)) dpi = (int)g.DpiX;
        return new Dictionary<string, object> {
            { "width", GetSystemMetrics(0) }, { "height", GetSystemMetrics(1) },
            { "workX", work.Left }, { "workY", work.Top },
            { "workWidth", work.Right - work.Left }, { "workHeight", work.Bottom - work.Top },
            { "dpi", dpi }, { "screens", GetSystemMetrics(80) },
        };
    }

    static object SetResolution(int width, int height)
    {
        var mode = new DEVMODE();
        mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        if (!EnumDisplaySettings(null, -1, ref mode)) throw new Exception("EnumDisplaySettings failed");
        mode.dmPelsWidth = width;
        mode.dmPelsHeight = height;
        mode.dmFields = 0x80000 | 0x100000; // DM_PELSWIDTH | DM_PELSHEIGHT
        int result = ChangeDisplaySettings(ref mode, 0);
        return new Dictionary<string, object> { { "result", result }, { "screen", Screen0() } };
    }

    static string Text(IntPtr hwnd)
    {
        var sb = new StringBuilder(512);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    static string ClassOf(IntPtr hwnd)
    {
        var sb = new StringBuilder(256);
        GetClassName(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    /// The window frame as the person sees it (without the invisible resize borders).
    static RECT Frame(IntPtr hwnd)
    {
        RECT r;
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0)
            GetWindowRect(hwnd, out r);
        return r;
    }

    static Dictionary<string, object> Describe(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        RECT frame = Frame(hwnd);
        RECT client;
        GetClientRect(hwnd, out client);
        var origin = new POINT();
        ClientToScreen(hwnd, ref origin);
        uint dpi = 96;
        try { dpi = GetDpiForWindow(hwnd); } catch (Exception) { }
        return new Dictionary<string, object> {
            { "hwnd", hwnd.ToInt64() }, { "pid", pid }, { "title", Text(hwnd) }, { "class", ClassOf(hwnd) },
            { "visible", IsWindowVisible(hwnd) }, { "minimized", IsIconic(hwnd) },
            { "x", frame.Left }, { "y", frame.Top }, { "width", frame.Right - frame.Left }, { "height", frame.Bottom - frame.Top },
            { "clientX", origin.X }, { "clientY", origin.Y },
            { "clientWidth", client.Right - client.Left }, { "clientHeight", client.Bottom - client.Top },
            { "dpi", dpi }, { "foreground", GetForegroundWindow() == hwnd },
        };
    }

    static object ListWindows(int pid, bool all)
    {
        var found = new List<object>();
        EnumWindows((hwnd, _) =>
        {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == (uint)pid && (all || IsWindowVisible(hwnd))) found.Add(Describe(hwnd));
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // ------------------------------------------------------------------------------------------
    // Screenshots
    // ------------------------------------------------------------------------------------------

    /// Whether every sampled pixel has the same colour (a capture that produced nothing).
    static bool Blank(Bitmap bmp)
    {
        Color first = bmp.GetPixel(0, 0);
        for (int y = 0; y < bmp.Height; y += Math.Max(1, bmp.Height / 24))
            for (int x = 0; x < bmp.Width; x += Math.Max(1, bmp.Width / 24))
                if (bmp.GetPixel(x, y).ToArgb() != first.ToArgb()) return false;
        return true;
    }

    static object Capture(IntPtr hwnd, string file)
    {
        if (!IsWindow(hwnd)) throw new Exception("the window does not exist");
        RECT outer;
        GetWindowRect(hwnd, out outer);
        RECT frame = Frame(hwnd);
        int width = frame.Right - frame.Left, height = frame.Bottom - frame.Top;
        if (width <= 0 || height <= 0) throw new Exception("the window has no size");
        string method = "PrintWindow";
        Bitmap shot = null;
        // PrintWindow with PW_RENDERFULLCONTENT also draws DirectComposition content (WebView2)
        // and works while other windows cover this one.
        using (var whole = new Bitmap(outer.Right - outer.Left, outer.Bottom - outer.Top, PixelFormat.Format24bppRgb))
        {
            bool printed;
            using (var g = Graphics.FromImage(whole))
            {
                IntPtr hdc = g.GetHdc();
                printed = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT);
                g.ReleaseHdc(hdc);
            }
            var crop = new Rectangle(frame.Left - outer.Left, frame.Top - outer.Top, width, height);
            crop.Intersect(new Rectangle(0, 0, whole.Width, whole.Height));
            if (printed && crop.Width > 0 && crop.Height > 0)
            {
                shot = whole.Clone(crop, PixelFormat.Format24bppRgb);
                if (Blank(shot)) { shot.Dispose(); shot = null; }
            }
        }
        if (shot == null)
        {
            // What is on the screen there, with the window brought to the front first.
            method = "screen";
            Focus(hwnd);
            Thread.Sleep(150);
            shot = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(frame.Left, frame.Top, 0, 0, new Size(width, height));
        }
        using (shot)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            shot.Save(file, ImageFormat.Png);
            return new Dictionary<string, object> { { "file", file }, { "method", method }, { "width", shot.Width }, { "height", shot.Height } };
        }
    }

    // ------------------------------------------------------------------------------------------
    // Focus, keys and the mouse
    // ------------------------------------------------------------------------------------------

    static void Send(params INPUT[] inputs)
    {
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
            throw new Exception("SendInput was blocked (error " + Marshal.GetLastWin32Error() + ")");
    }

    static INPUT Key(ushort vk, bool up)
    {
        var input = new INPUT { type = INPUT_KEYBOARD };
        input.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? KEYEVENTF_KEYUP : 0 };
        return input;
    }

    /// Makes the window the foreground window, as far as Windows allows a background process.
    static bool Focus(IntPtr hwnd)
    {
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9); // SW_RESTORE
        for (int attempt = 0; attempt < 10; attempt++)
        {
            if (GetForegroundWindow() == hwnd) return true;
            uint ignored;
            uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
            uint me = GetCurrentThreadId();
            bool attached = foregroundThread != 0 && foregroundThread != me && AttachThreadInput(me, foregroundThread, true);
            // An input event of this process (a mouse move by nothing) lets it set the foreground
            // window.
            var nudge = new INPUT { type = INPUT_MOUSE };
            nudge.u.mi = new MOUSEINPUT { dwFlags = MOUSEEVENTF_MOVE };
            try { Send(nudge); } catch (Exception) { }
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
            if (attached) AttachThreadInput(me, foregroundThread, false);
            Thread.Sleep(100);
        }
        return GetForegroundWindow() == hwnd;
    }

    static ushort VirtualKey(string key, out bool shift)
    {
        shift = false;
        switch (key)
        {
            case "Escape": return 0x1B;
            case "Enter": return 0x0D;
            case "Tab": return 0x09;
            case "Backspace": return 0x08;
            case "ArrowUp": return 0x26;
            case "ArrowDown": return 0x28;
            case "ArrowLeft": return 0x25;
            case "ArrowRight": return 0x27;
            case "F4": return 0x73;
            case "F5": return 0x74;
            case "F12": return 0x7B;
        }
        if (key.Length != 1) throw new ArgumentException("unknown key " + key);
        short scan = VkKeyScan(key[0]);
        if (scan == -1) throw new ArgumentException("no key for " + key);
        shift = (scan & 0x100) != 0;
        return (ushort)(scan & 0xff);
    }

    static object PressKey(IntPtr hwnd, string key, bool ctrl, bool shift, bool alt)
    {
        bool foreground = Focus(hwnd);
        bool keyShift;
        ushort vk = VirtualKey(key, out keyShift);
        var down = new List<INPUT>();
        var up = new List<INPUT>();
        if (ctrl) { down.Add(Key(VK_CONTROL, false)); up.Insert(0, Key(VK_CONTROL, true)); }
        if (alt) { down.Add(Key(VK_MENU, false)); up.Insert(0, Key(VK_MENU, true)); }
        if (shift || keyShift) { down.Add(Key(VK_SHIFT, false)); up.Insert(0, Key(VK_SHIFT, true)); }
        down.Add(Key(vk, false));
        up.Insert(0, Key(vk, true));
        down.AddRange(up);
        Send(down.ToArray());
        return new Dictionary<string, object> { { "foreground", foreground }, { "vk", vk } };
    }

    static INPUT Mouse(int x, int y, uint flags)
    {
        // Absolute coordinates are 0..65535 across the virtual desktop.
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
        int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        var input = new INPUT { type = INPUT_MOUSE };
        input.u.mi = new MOUSEINPUT
        {
            dx = (int)Math.Round((x - left) * 65535.0 / Math.Max(1, width - 1)),
            dy = (int)Math.Round((y - top) * 65535.0 / Math.Max(1, height - 1)),
            dwFlags = flags | MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        };
        return input;
    }

    static object Drag(IntPtr hwnd, int[] from, int[] to)
    {
        bool foreground = Focus(hwnd);
        Send(Mouse(from[0], from[1], 0));
        Thread.Sleep(100);
        Send(Mouse(from[0], from[1], MOUSEEVENTF_LEFTDOWN));
        Thread.Sleep(100);
        const int steps = 20;
        for (int i = 1; i <= steps; i++)
        {
            Send(Mouse(from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps, 0));
            Thread.Sleep(15);
        }
        Thread.Sleep(100);
        Send(Mouse(to[0], to[1], MOUSEEVENTF_LEFTUP));
        Thread.Sleep(200);
        var result = Describe(hwnd);
        result["foregroundBefore"] = foreground;
        return result;
    }

    /// A click with the left or right button at `at`, pixels from the client area's top left.
    static object Click(IntPtr hwnd, int[] at, string button)
    {
        bool foreground = Focus(hwnd);
        var point = new POINT { X = at[0], Y = at[1] };
        ClientToScreen(hwnd, ref point);
        bool right = button == "right";
        Send(Mouse(point.X, point.Y, 0));
        Thread.Sleep(100);
        Send(Mouse(point.X, point.Y, right ? 0x0008u : MOUSEEVENTF_LEFTDOWN));
        Thread.Sleep(50);
        Send(Mouse(point.X, point.Y, right ? 0x0010u : MOUSEEVENTF_LEFTUP));
        Thread.Sleep(200);
        return new Dictionary<string, object> { { "foreground", foreground }, { "x", point.X }, { "y", point.Y } };
    }

    /// Turns the mouse wheel at `at` (screen pixels) by `delta` (120 is one notch away from the
    /// person), with Ctrl held when `ctrl`.
    static object Wheel(IntPtr hwnd, int[] at, int delta, bool ctrl)
    {
        bool foreground = Focus(hwnd);
        Send(Mouse(at[0], at[1], 0));
        Thread.Sleep(100);
        if (ctrl) Send(Key(VK_CONTROL, false));
        var wheel = Mouse(at[0], at[1], 0x0800); // MOUSEEVENTF_WHEEL
        wheel.u.mi.mouseData = unchecked((uint)delta);
        Send(wheel);
        Thread.Sleep(50);
        if (ctrl) Send(Key(VK_CONTROL, true));
        Thread.Sleep(200);
        return new Dictionary<string, object> { { "foreground", foreground } };
    }

    // ------------------------------------------------------------------------------------------
    // A window over the app's window, and programs started from this process
    // ------------------------------------------------------------------------------------------

    static Form cover;
    static IntPtr coverHandle = IntPtr.Zero;
    static Thread coverThread;

    /// Covers the window with an opaque window of this process (with a margin, so no edge of the
    /// app shows) and makes it the foreground window.
    static object Cover(IntPtr hwnd)
    {
        Uncover();
        if (!IsWindow(hwnd)) throw new Exception("the window does not exist");
        RECT f = Frame(hwnd);
        const int margin = 24;
        var bounds = new Rectangle(f.Left - margin, f.Top - margin, f.Right - f.Left + 2 * margin, f.Bottom - f.Top + 2 * margin);
        var shown = new ManualResetEvent(false);
        IntPtr handle = IntPtr.Zero;
        coverThread = new Thread(() =>
        {
            var form = new Form
            {
                Text = "VidAI end-to-end cover",
                FormBorderStyle = FormBorderStyle.None,
                StartPosition = FormStartPosition.Manual,
                ShowInTaskbar = false,
                BackColor = SystemColors.Window,
                Bounds = bounds,
            };
            form.Shown += (sender, e) => { handle = form.Handle; shown.Set(); };
            cover = form;
            Application.Run(form);
        });
        coverThread.SetApartmentState(ApartmentState.STA);
        coverThread.IsBackground = true;
        coverThread.Start();
        if (!shown.WaitOne(10000)) throw new Exception("the cover window did not show");
        coverHandle = handle;
        bool foreground = Focus(handle);
        return new Dictionary<string, object> {
            { "hwnd", handle.ToInt64() }, { "foreground", foreground },
            { "bounds", new[] { f.Left, f.Top, f.Right - f.Left, f.Bottom - f.Top } },
        };
    }

    static object Uncover()
    {
        var form = cover;
        cover = null;
        coverHandle = IntPtr.Zero;
        if (form == null) return false;
        try { form.Invoke((MethodInvoker)(() => form.Close())); } catch (Exception) { }
        if (coverThread != null) coverThread.Join(3000);
        coverThread = null;
        return true;
    }

    /// Starts `file` from this process with these environment variables changed (a null value
    /// removes one), and waits up to `timeout` ms for it to end; one that does not end is ended.
    static object Start(string file, string cwd, Dictionary<string, object> env, int timeout)
    {
        var info = new ProcessStartInfo(file) { UseShellExecute = false, WorkingDirectory = cwd, CreateNoWindow = true };
        foreach (var pair in env)
        {
            if (pair.Value == null) info.EnvironmentVariables.Remove(pair.Key);
            else info.EnvironmentVariables[pair.Key] = Convert.ToString(pair.Value);
        }
        var watch = Stopwatch.StartNew();
        bool foregroundBefore = coverHandle != IntPtr.Zero && GetForegroundWindow() == coverHandle;
        using (var process = Process.Start(info))
        {
            bool exited = process.WaitForExit(timeout);
            if (!exited) { try { process.Kill(); } catch (Exception) { } }
            return new Dictionary<string, object> {
                { "pid", process.Id }, { "exited", exited }, { "code", exited ? (object)process.ExitCode : null },
                { "ms", watch.ElapsedMilliseconds }, { "coverWasForeground", foregroundBefore },
            };
        }
    }

    // ------------------------------------------------------------------------------------------
    // Clipboard (saved in this process, so every format comes back exactly)
    // ------------------------------------------------------------------------------------------

    static DataObject saved;

    static T Retry<T>(Func<T> action)
    {
        for (int attempt = 0; ; attempt++)
        {
            try { return action(); }
            catch (ExternalException) { if (attempt >= 20) throw; Thread.Sleep(50); }
        }
    }

    static object ClipboardSave()
    {
        return Retry(() =>
        {
            var copy = new DataObject();
            var current = Clipboard.GetDataObject();
            int formats = 0;
            if (current != null)
            {
                foreach (string format in current.GetFormats(false))
                {
                    try
                    {
                        object data = current.GetData(format, false);
                        if (data != null) { copy.SetData(format, false, data); formats++; }
                    }
                    catch (Exception) { }
                }
            }
            saved = copy;
            return formats;
        });
    }

    static object ClipboardRestore()
    {
        if (saved == null) return false;
        var data = saved;
        saved = null;
        return Retry(() =>
        {
            if (data.GetFormats().Length == 0) Clipboard.Clear();
            else Clipboard.SetDataObject(data, true, 10, 50);
            return true;
        });
    }

    // ------------------------------------------------------------------------------------------
    // Processes
    // ------------------------------------------------------------------------------------------

    static object Processes()
    {
        var list = new List<object>();
        var query = "SELECT ProcessId, ParentProcessId, Name, CommandLine, CreationDate FROM Win32_Process";
        using (var searcher = new ManagementObjectSearcher(query))
        using (var results = searcher.Get())
        {
            foreach (ManagementBaseObject item in results)
            {
                using (var p = item)
                {
                    long started = 0;
                    var created = p["CreationDate"] as string;
                    if (!string.IsNullOrEmpty(created))
                    {
                        var at = ManagementDateTimeConverter.ToDateTime(created).ToUniversalTime();
                        started = (long)(at - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                    }
                    list.Add(new Dictionary<string, object> {
                        { "pid", Convert.ToInt64(p["ProcessId"]) }, { "ppid", Convert.ToInt64(p["ParentProcessId"]) },
                        { "name", p["Name"] as string ?? "" }, { "command", p["CommandLine"] as string ?? "" },
                        { "started", started },
                    });
                }
            }
        }
        return list;
    }

    // ------------------------------------------------------------------------------------------
    // Windows that show up (console windows flashing, error dialogs, Explorer windows)
    // ------------------------------------------------------------------------------------------

    static Thread watcher;
    static uint watcherThread;
    static WinEventProc watchProc;
    static readonly List<object> shown = new List<object>();

    static void OnShow(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (idObject != 0 || idChild != 0 || hwnd == IntPtr.Zero) return;
        if (GetAncestor(hwnd, GA_ROOT) != hwnd) return;
        try
        {
            var info = Describe(hwnd);
            info["at"] = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            info["owned"] = GetWindow(hwnd, GW_OWNER) != IntPtr.Zero;
            try { info["process"] = Process.GetProcessById(Convert.ToInt32(info["pid"])).ProcessName; } catch (Exception) { info["process"] = ""; }
            lock (shown) { if (shown.Count < 2000) shown.Add(info); }
        }
        catch (Exception) { }
    }

    static object WatchStart()
    {
        StopWatch();
        lock (shown) shown.Clear();
        var started = new ManualResetEvent(false);
        watchProc = OnShow;
        watcher = new Thread(() =>
        {
            watcherThread = GetCurrentThreadId();
            // Out of context, skipping this process: the callback runs on this thread's loop.
            IntPtr hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, watchProc, 0, 0, 0 | 2);
            started.Set();
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
            UnhookWinEvent(hook);
        });
        watcher.IsBackground = true;
        watcher.Start();
        started.WaitOne(5000);
        return true;
    }

    static object StopWatch()
    {
        if (watcher != null)
        {
            PostThreadMessage(watcherThread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            watcher.Join(2000);
            watcher = null;
        }
        lock (shown) return new List<object>(shown);
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @(
  "System.Drawing", "System.Windows.Forms", "System.Management", "System.Web.Extensions"
)
[VidaiE2E]::Run()

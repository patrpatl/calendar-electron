param(
    [Parameter(Mandatory = $true)][int]$TargetProcessId,
    [switch]$Show
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CalendarWindowProbe {
    public delegate bool EnumCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr data);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    public struct Rect { public int Left, Top, Right, Bottom; }
    public static IntPtr Find(int process) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            if (owner == process && title.ToString() == "Calendar") { result = window; return false; }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
$handle = [CalendarWindowProbe]::Find($TargetProcessId)
if ($handle -eq [IntPtr]::Zero) { throw "No Calendar window found for process $TargetProcessId." }
if ($Show) {
    [CalendarWindowProbe]::ShowWindow($handle, 9) | Out-Null
    [CalendarWindowProbe]::SetForegroundWindow($handle) | Out-Null
}
$rectangle = New-Object CalendarWindowProbe+Rect
[CalendarWindowProbe]::GetWindowRect($handle, [ref]$rectangle) | Out-Null
$bounds = [System.Drawing.Rectangle]::FromLTRB($rectangle.Left, $rectangle.Top, $rectangle.Right, $rectangle.Bottom)
$onScreen = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.WorkingArea.IntersectsWith($bounds) }).Count -gt 0
@{
    visible = [CalendarWindowProbe]::IsWindowVisible($handle)
    onScreen = $onScreen
    left = $rectangle.Left
    top = $rectangle.Top
    width = $bounds.Width
    height = $bounds.Height
} | ConvertTo-Json -Compress

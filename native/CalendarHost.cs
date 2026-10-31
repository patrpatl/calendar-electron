using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

internal sealed class CalendarHost : Form
{
    private const string Entry = "https://calendar.example/index.html";
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    private readonly StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
    private readonly string root;
    private readonly string profile;
    private readonly string smokeScript;
    private CoreWebView2Controller controller;
    private CoreWebView2 core;
    private bool allowClose;
    private bool documentReady;
    private bool failed;
    private bool firstMessage = true;
    private string closeRequest;
    private string theme = "system";
    private readonly Stopwatch startup = Stopwatch.StartNew();

    private void Trace(string stage)
    {
        if (Environment.GetEnvironmentVariable("CALENDAR_STARTUP_TRACE") == "1")
            Emit(new { kind = "trace", stage = stage, milliseconds = startup.ElapsedMilliseconds });
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2) return 1;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var window = new CalendarHost(args[0], args[1], args.Length > 2 ? args[2] : null))
                Application.Run(window);
            return Environment.ExitCode;
        }
        catch (Exception error)
        {
            using (var stderr = new StreamWriter(Console.OpenStandardError()) { AutoFlush = true })
                stderr.WriteLine("WebView host: " + error.Message);
            return 1;
        }
    }

    private CalendarHost(string appRoot, string userProfile, string testScript)
    {
        root = Path.GetFullPath(appRoot);
        profile = Path.GetFullPath(userProfile);
        smokeScript = testScript;
        Trace("host-created");
        Text = "Calendar";
        Size = new Size(1280, 860);
        MinimumSize = new Size(760, 620);
        StartPosition = FormStartPosition.CenterScreen;
        Trace("window-configured");
        if (smokeScript != null)
        {
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
        }
        Resize += delegate { if (controller != null) controller.Bounds = ClientRectangle; };
        LocationChanged += delegate { if (controller != null) controller.NotifyParentWindowPositionChanged(); };
        Activated += delegate { if (controller != null) controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic); };
        Shown += async delegate { await Initialize(); };
        FormClosing += OnClosing;
        FormClosed += delegate { SystemEvents.UserPreferenceChanged -= OnSystemThemeChanged; if (controller != null) controller.Close(); };
        SystemEvents.UserPreferenceChanged += OnSystemThemeChanged;
        Trace("events-registered");
    }

    private void Emit(object value) { output.WriteLine(json.Serialize(value)); }

    private void Fail(string reason)
    {
        if (failed) return;
        failed = true;
        Environment.ExitCode = 1;
        Emit(new { kind = "fatal", error = reason });
        allowClose = true;
        Close();
    }

    private async Task Initialize()
    {
        try
        {
            Trace("initializing");
            // Evergreen resolves the installed system runtime, with no bundled Chromium.
            CoreWebView2Environment.GetAvailableBrowserVersionString();
            Trace("runtime-found");
            // All renderer assets are mapped local files; Google traffic goes
            // through Node. Avoid proxy auto-discovery on local asset requests.
            var options = new CoreWebView2EnvironmentOptions("--no-proxy-server");
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(profile, "WebView2"), options);
            Trace("environment-created");
            // Host the native controller directly. The WinForms WebView2 wrapper
            // adds control initialization work that the single-window app does not need.
            controller = await environment.CreateCoreWebView2ControllerAsync(Handle);
            controller.Bounds = ClientRectangle;
            controller.IsVisible = true;
            core = controller.CoreWebView2;
            Trace("webview-created");
            core.SetVirtualHostNameToFolderMapping("calendar.example", Path.Combine(root, "dist"), CoreWebView2HostResourceAccessKind.DenyCors);
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args) { args.State = CoreWebView2PermissionState.Deny; };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args) { args.Handled = true; };
            core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs args) { args.Cancel = true; };
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args)
            {
                if (args.Uri != Entry || documentReady) args.Cancel = true;
            };
            core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) { args.Cancel = true; };
            core.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs args) { Fail("WebView process failed: " + args.ProcessFailedKind); };
            environment.BrowserProcessExited += delegate { if (!IsDisposed && !allowClose) Fail("The WebView browser process exited."); };
            core.WebMessageReceived += OnWebMessage;
            core.DOMContentLoaded += delegate { Trace("dom-loaded"); };
            core.NavigationCompleted += async delegate(object sender, CoreWebView2NavigationCompletedEventArgs args)
            {
                Trace("navigation-completed");
                if (!args.IsSuccess) { Fail("WebView navigation failed: " + args.WebErrorStatus); return; }
                if (smokeScript != null)
                {
                    try { await core.ExecuteScriptAsync(File.ReadAllText(smokeScript)); }
                    catch (Exception error) { Fail(error.Message); }
                }
            };
            await core.AddScriptToExecuteOnDocumentCreatedAsync(File.ReadAllText(Path.Combine(root, "native", "bridge.js")));
            Trace("bridge-injected");
            ApplyTheme();
            Trace("theme-applied");
            // Begin reading only after WebView initialization so host RPCs are ready.
            var reader = ReadInput();
            Trace("backend-listening");
            core.Navigate(Entry);
            Trace("navigating");
        }
        catch (Exception error) { Fail(error.Message); }
    }

    private async Task ReadInput()
    {
        try
        {
            using (var input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8))
            {
                string line;
                while ((line = await input.ReadLineAsync()) != null)
                {
                    var message = json.Deserialize<Dictionary<string, object>>(line);
                    await OnInput(message);
                }
            }
            // The backend disappeared; do not leave a window with dead save buttons.
            allowClose = true;
            Close();
        }
        catch (Exception error) { if (!IsDisposed) Fail(error.Message); }
    }

    private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (firstMessage) Trace("first-message-received");
        if (args.Source != Entry || core.Source != Entry) return;
        try
        {
            var message = json.Deserialize<Dictionary<string, object>>(args.WebMessageAsJson);
            if (firstMessage) { Trace("first-message-parsed"); firstMessage = false; }
            var kind = Convert.ToString(message["kind"]);
            if (kind == "invoke")
            {
                // Never forward renderer messages as native commands (DPAPI, file
                // dialogs, browser launches). Node independently checks API channels.
                Emit(new { kind = "invoke", id = message["id"], channel = message["channel"], value = message.ContainsKey("value") ? message["value"] : null });
            }
            else if (kind == "document-ready") { documentReady = true; Trace("document-ready"); }
            else if (kind == "ready") { Trace("renderer-ready"); Emit(new { kind = "ready" }); }
            else if (kind == "renderer-error") Fail("The WebView renderer encountered an error.");
            else if (kind == "close-ready" && closeRequest != null && Convert.ToString(message["requestId"]) == closeRequest)
            {
                closeRequest = null;
                if (message["ok"] is bool && (bool)message["ok"]) { allowClose = true; Close(); }
            }
            else if (kind == "smoke-result" && smokeScript != null) Emit(message);
        }
        catch (Exception error) { Fail("Invalid WebView message: " + error.Message); }
    }

    private async Task OnInput(Dictionary<string, object> message)
    {
        var kind = Convert.ToString(message["kind"]);
        if (kind == "result" || kind == "event")
        {
            if (core.Source == Entry) core.PostWebMessageAsJson(json.Serialize(message));
        }
        else if (kind == "focus")
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }
        else if (kind == "close") Close();
        else if (kind == "quit") { allowClose = true; Close(); }
        else if (kind == "native")
        {
            try
            {
                var result = await Native(Convert.ToString(message["action"]), message.ContainsKey("value") ? message["value"] : null);
                Emit(new { kind = "native-result", id = message["id"], ok = true, result = result });
            }
            catch (Exception error) { Emit(new { kind = "native-result", id = message["id"], ok = false, error = error.Message }); }
        }
    }

    private Task<object> Native(string action, object value)
    {
        object result = null;
        switch (action)
        {
            case "theme":
                theme = Convert.ToString(value);
                ApplyTheme();
                break;
            case "protect":
                result = Convert.ToBase64String(ProtectedData.Protect(Convert.FromBase64String((string)value), null, DataProtectionScope.CurrentUser));
                break;
            case "unprotect":
                result = Convert.ToBase64String(ProtectedData.Unprotect(Convert.FromBase64String((string)value), null, DataProtectionScope.CurrentUser));
                break;
            case "open-external":
                var url = new Uri((string)value);
                if (url.Scheme != "https" || url.Host != "accounts.google.com") throw new InvalidOperationException("Only Google sign-in links can be opened.");
                Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true });
                break;
            case "import-client":
                using (var picker = new OpenFileDialog { Title = "Import Google OAuth Desktop client", Filter = "OAuth client JSON (*.json)|*.json", Multiselect = false })
                    if (picker.ShowDialog(this) == DialogResult.OK) result = picker.FileName;
                break;
            case "confirm-restore":
                var backup = (Dictionary<string, object>)value;
                var count = Convert.ToInt32(backup["count"]);
                var created = DateTime.Parse((string)backup["createdAt"]).ToLocalTime();
                result = MessageBox.Show(this, "Replace this device's calendar with " + count + " events from Drive?\n\nBackup created: " + created + "\n\nA safety copy of your current events will be saved in the local backups folder before anything is replaced.", "Restore Calendar from Google Drive", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.OK;
                break;
            default: throw new InvalidOperationException("Unknown native operation.");
        }
        return Task.FromResult(result);
    }

    private void ApplyTheme()
    {
        if (core == null) return;
        core.Profile.PreferredColorScheme = theme == "dark" ? CoreWebView2PreferredColorScheme.Dark : theme == "light" ? CoreWebView2PreferredColorScheme.Light : CoreWebView2PreferredColorScheme.Auto;
        bool dark = theme == "dark";
        if (theme == "system")
        {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                dark = key != null && Convert.ToInt32(key.GetValue("AppsUseLightTheme", 1)) == 0;
        }
        BackColor = SystemInformation.HighContrast ? SystemColors.Window : dark ? Color.FromArgb(32, 34, 31) : Color.FromArgb(231, 233, 227);
        controller.DefaultBackgroundColor = BackColor;
        var mode = dark ? 1 : 0;
        DwmSetWindowAttribute(Handle, 20, ref mode, sizeof(int));
    }

    private void OnSystemThemeChanged(object sender, UserPreferenceChangedEventArgs args)
    {
        if (!IsDisposed && IsHandleCreated) BeginInvoke(new Action(ApplyTheme));
    }

    private void OnClosing(object sender, FormClosingEventArgs args)
    {
        if (allowClose) return;
        if (!documentReady || core == null)
        {
            Emit(new { kind = "user-close" });
            return;
        }
        args.Cancel = true;
        if (closeRequest != null) return;
        closeRequest = Guid.NewGuid().ToString();
        core.PostWebMessageAsJson(json.Serialize(new { kind = "flush-editor", requestId = closeRequest }));
    }
}

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Linq;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal sealed class LauncherContext : ApplicationContext
{
    private readonly NotifyIcon tray;
    private readonly Icon trayIcon;
    private readonly Process node;
    private Process desktop;
    private NamedPipeServerStream desktopPipe;
    private StreamWriter desktopWriter;
    private readonly object pipeLock = new object();
    private readonly string tempRoot;
    private readonly StringBuilder errors = new StringBuilder();
    private readonly object errorLock = new object();
    private readonly bool hiddenWindow;
    private volatile bool windowsShutdown;
    private readonly Control dispatcher = new Control();
    private string appUrl;
    private volatile bool ready, serverReady, closing;
    private System.Threading.Timer startupTimer;
    private JobHandle job;
    private static void Trace(string message) { if(Environment.GetCommandLineArgs().Contains("--diagnostics"))try { Console.Out.WriteLine("LAUNCHER " + message); Console.Out.Flush(); } catch { } }

    private LauncherContext(string temp, bool suppressWindow)
    {
        tempRoot = temp; hiddenWindow = suppressWindow;
        IntPtr dispatcherHandle = dispatcher.Handle;
        var menu = new ContextMenuStrip();
        menu.Items.Add("Öffnen", null, delegate { OpenApp(); });
        menu.Items.Add("Beenden", null, delegate { ExitThread(); });
        trayIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        tray = new NotifyIcon { Icon = trayIcon ?? SystemIcons.Application, Text = "Netzwerk-Kompass startet…", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { OpenApp(); };
        node = new Process();
        node.StartInfo = new ProcessStartInfo(Path.Combine(tempRoot, "runtime", "node.exe"), "\"" + Path.Combine(tempRoot, "server.js") + "\" --launcher --no-browser") {
            WorkingDirectory = tempRoot, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        var env = node.StartInfo.EnvironmentVariables;
        env.Remove("NODE_OPTIONS"); env.Remove("NODE_PATH");
        env["NETZWERK_KOMPASS_DATA_DIR"] = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Netzwerk-Kompass-Daten"));
        env["NETZWERK_KOMPASS_EXE_PATH"] = Process.GetCurrentProcess().MainModule.FileName;
        if(hiddenWindow || Environment.GetCommandLineArgs().Any(a => String.Equals(a, "--no-autostart-registration", StringComparison.OrdinalIgnoreCase)))
            env["NETZWERK_KOMPASS_NO_AUTOSTART_REGISTRATION"] = "1";
        node.OutputDataReceived += OutputLine; node.ErrorDataReceived += ErrorLine;
        node.EnableRaisingEvents = true;
        node.Exited += NodeExited;
    }

    private void StartNode()
    {
        try {
            node.Start();
            Trace("node-started");
            job = CreateKillJob(node);
            if (job == null) { try { node.Kill(); } catch { } throw new InvalidOperationException("Der Node-Prozess konnte nicht an die Prozessüberwachung gebunden werden."); }
            node.BeginOutputReadLine(); node.BeginErrorReadLine();
            startupTimer = new System.Threading.Timer(delegate { if (!ready) BeginInvokeExit("Der lokale Server hat nicht rechtzeitig gestartet."); }, null, 60000, Timeout.Infinite);
        } catch (Exception ex) { ShowError("Der lokale Server konnte nicht gestartet werden: " + ex.Message); ExitThread(); }
    }

    public static void Run()
    {
        bool suppressWindow = Environment.GetCommandLineArgs().Any(a => String.Equals(a, "--hidden-window", StringComparison.OrdinalIgnoreCase));
        string appData = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Netzwerk-Kompass-Daten"));
        string mutexName = "Global\\NetzwerkKompass_" + Hash(appData.ToLowerInvariant());
        bool created;
        Mutex mutex = new Mutex(true, mutexName, out created);
        if (!created) { MessageBox.Show("Netzwerk-Kompass läuft bereits. Über das Symbol im Infobereich können Sie die Oberfläche wieder öffnen.", "Netzwerk-Kompass", MessageBoxButtons.OK, MessageBoxIcon.Information); mutex.Dispose(); return; }
        string temp = Path.Combine(Path.GetTempPath(), "Netzwerk-Kompass-" + Guid.NewGuid().ToString("N"));
        try {
            Directory.CreateDirectory(appData);
            using(var probe = new FileStream(Path.Combine(appData,".write-test-" + Guid.NewGuid().ToString("N")),FileMode.CreateNew,FileAccess.Write,FileShare.None,1,FileOptions.DeleteOnClose)) { probe.WriteByte(0); }
            Directory.CreateDirectory(temp); ExtractPayload(temp);
            Trace("payload-extracted " + temp);
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            var context = new LauncherContext(temp, suppressWindow);
            SystemEvents.SessionEnded += context.SessionEnded;
            EventHandler start = null;
            start = delegate { Application.Idle -= start; Trace("application-idle"); context.StartNode(); };
            Application.Idle += start;
            Application.Run(context);
        }
        catch (Exception ex) {
            Environment.ExitCode = 1;
            string message = "Die eingebettete App konnte nicht vorbereitet werden: " + ex.Message;
            if(suppressWindow) { try { Console.Error.WriteLine(message); Console.Error.Flush(); } catch { } }
            else MessageBox.Show(message, "Netzwerk-Kompass", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally {
            string tempParent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string resolved = Path.GetFullPath(temp);
            try { if (resolved.StartsWith(tempParent,StringComparison.OrdinalIgnoreCase) && Path.GetFileName(resolved).StartsWith("Netzwerk-Kompass-",StringComparison.Ordinal) && Directory.Exists(resolved)) Directory.Delete(resolved, true); } catch { }
            try { mutex.ReleaseMutex(); } catch { } mutex.Dispose();
        }
    }

    private void SessionEnded(object sender, SessionEndedEventArgs e)
    {
        if(e.Reason != SessionEndReasons.Logoff && e.Reason != SessionEndReasons.SystemShutdown) return;
        windowsShutdown = true;
        Dispatch(delegate { ExitThread(); });
    }

    private static void ExtractPayload(string destination)
    {
        var assembly = typeof(LauncherContext).Assembly;
        using (Stream stream = assembly.GetManifestResourceStream("NetzwerkKompass.Payload.zip"))
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Read)) {
            string root = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            foreach (var entry in archive.Entries) {
                string full = Path.GetFullPath(Path.Combine(destination, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Unsicherer Pfad im App-Archiv.");
                if (entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal)) { Directory.CreateDirectory(full); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(full));
                using (var input = entry.Open()) using (var output = new FileStream(full, FileMode.CreateNew, FileAccess.Write)) input.CopyTo(output);
            }
        }
    }

    private static string Hash(string value) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", ""); }
    private void OutputLine(object sender, DataReceivedEventArgs e)
    {
        if (e.Data == null) return;
        var match = Regex.Match(e.Data, @"^http://127\.0\.0\.1:[0-9]{1,5}$");
        if (!match.Success) return;
        if (serverReady) return;
        serverReady = true;
        Trace("server-ready");
        Dispatch(delegate {
            if (closing) return;
            appUrl = match.Value;
            try { StartDesktop(); } catch(Exception ex) { ShowError("Das Programmfenster konnte nicht vorbereitet werden: " + ex.Message); ExitThread(); }
        });
    }
    private void StartDesktop()
    {
        string pipeName = "netzwerk-kompass-desktop-" + Guid.NewGuid().ToString("D");
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true,false);
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
        desktopPipe = new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,0,0,security);
        ThreadPool.QueueUserWorkItem(delegate {
            try {
                desktopPipe.WaitForConnection();
                Trace("desktop-pipe-connected");
                lock(pipeLock)desktopWriter = new StreamWriter(desktopPipe,new UTF8Encoding(false),1024,true) { AutoFlush = true };
                using(var reader = new StreamReader(desktopPipe,Encoding.UTF8,false,1024,true)) {
                    string line;
                    while(!closing && (line = reader.ReadLine()) != null) {
                        if(line == "DESKTOP_READY" && !ready) {
                            Trace("desktop-ready");
                            ready = true;
                            Dispatch(delegate { if(startupTimer != null)startupTimer.Dispose(); tray.Text = "Netzwerk-Kompass"; });
                            try { Console.Out.WriteLine(appUrl); Console.Out.Flush(); } catch { }
                        } else if(line.StartsWith("DESKTOP_ERROR ",StringComparison.Ordinal)) {
                            Trace("desktop-error");
                            BeginInvokeExit(line.Substring(14)); return;
                        }
                    }
                }
                Dispatch(delegate { if(!closing)ExitThread(); });
                Trace("desktop-pipe-eof");
            } catch(Exception ex) { if(!closing)BeginInvokeExit("Die Verbindung zum Programmfenster wurde unterbrochen: " + ex.Message); }
        });
        desktop = new Process();
        desktop.StartInfo = new ProcessStartInfo(Path.Combine(tempRoot,"runtime","electron","Netzwerk-Kompass-Desktop.exe"),"\"" + Path.Combine(tempRoot,"desktop","main.cjs") + "\"" + (hiddenWindow ? " --hidden-window" : "")) {
            WorkingDirectory = tempRoot, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        var env = desktop.StartInfo.EnvironmentVariables;
        env.Remove("NODE_OPTIONS"); env.Remove("NODE_PATH"); env.Remove("ELECTRON_RUN_AS_NODE");
        env["NETZWERK_KOMPASS_URL"] = appUrl;
        env["NETZWERK_KOMPASS_CONTROL_PIPE"] = pipeName;
        env["NETZWERK_KOMPASS_DATA_DIR"] = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Netzwerk-Kompass-Daten"));
        desktop.ErrorDataReceived += ErrorLine;
        desktop.EnableRaisingEvents = true;
        desktop.Exited += DesktopExited;
        try {
            desktop.Start();
            Trace("desktop-started");
            if(job == null || !job.Assign(desktop)) { try { desktop.Kill(); } catch { } throw new InvalidOperationException("Das Programmfenster konnte nicht an die Prozessüberwachung gebunden werden."); }
            desktop.BeginOutputReadLine(); desktop.BeginErrorReadLine();
        } catch(Exception ex) { ShowError("Das Programmfenster konnte nicht gestartet werden: " + ex.Message); ExitThread(); }
    }
    // Exited is raised on a ThreadPool thread, concurrently with shutdown.
    // Read Process only on the UI thread, which also owns Process.Dispose().
    private void NodeExited(object sender, EventArgs e)
    {
        Dispatch(delegate {
            if(closing)return;
            node.WaitForExit();
            Trace("node-exit " + node.ExitCode);
            if(node.ExitCode != 0) ShowError("Die App wurde mit einem Fehler beendet (" + node.ExitCode + ").");
            else if(!ready) ShowError("Der lokale Server wurde beendet, bevor das Programmfenster bereit war.");
            ExitThread();
        });
    }
    private void DesktopExited(object sender, EventArgs e)
    {
        Dispatch(delegate {
            if(closing)return;
            desktop.WaitForExit();
            Trace("desktop-exit " + desktop.ExitCode);
            if(desktop.ExitCode != 0)ShowError("Das Programmfenster wurde mit einem Fehler beendet (" + desktop.ExitCode + ").");
            else if(!ready)ShowError("Das Programmfenster wurde beendet, bevor die Oberfläche geladen war.");
            ExitThread();
        });
    }
    private void ErrorLine(object sender, DataReceivedEventArgs e) { if (e.Data == null) return; lock(errorLock) { if(errors.Length < 8192) errors.AppendLine(e.Data.Length > 1000 ? e.Data.Substring(0,1000) : e.Data); } if(hiddenWindow)try { Console.Error.WriteLine(e.Data); Console.Error.Flush(); } catch { } }
    private void Dispatch(MethodInvoker action) { try { if(!closing) dispatcher.BeginInvoke(action); } catch (InvalidOperationException) { } }
    private void BeginInvokeExit(string message) { Dispatch(delegate { if(closing)return; ShowError(message); ExitThread(); }); }
    private string ErrorDetails() { lock(errorLock) return errors.Length == 0 ? "" : "\r\n\r\n" + errors.ToString(); }
    private void ShowError(string message) { Environment.ExitCode = 1; if(hiddenWindow)try { Console.Error.WriteLine(message + ErrorDetails()); Console.Error.Flush(); } catch { } else MessageBox.Show(message + ErrorDetails(), "Netzwerk-Kompass", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    private void SendDesktop(string command) { lock(pipeLock) { if(desktopWriter != null)desktopWriter.WriteLine(command); } }
    private void OpenApp() { if(ready && desktop != null) try { if(!desktop.HasExited)SendDesktop("show"); } catch(Exception ex) { ShowError("Das Programmfenster konnte nicht angezeigt werden: " + ex.Message); } }
    protected override void ExitThreadCore()
    {
        if (closing) { base.ExitThreadCore(); return; }
        closing = true; if (startupTimer != null) startupTimer.Dispose();
        SystemEvents.SessionEnded -= SessionEnded;
        Trace("shutdown-started");
        if(desktop != null)try { if(!desktop.HasExited)SendDesktop("shutdown"); } catch { }
        // Server shutdown allows 12 seconds for capture stop and durable flush;
        // leave a further second before forcibly ending its process.
        try { if (!node.HasExited) { node.StandardInput.WriteLine(windowsShutdown ? "shutdown:windows_shutdown" : "shutdown"); node.StandardInput.Close(); if (!node.WaitForExit(13000)) node.Kill(); } } catch { try { if (!node.HasExited) node.Kill(); } catch { } }
        if(desktop != null)try { if(!desktop.WaitForExit(3000))desktop.Kill(); } catch { }
        if (job != null) job.Dispose();
        try { node.WaitForExit(3000); node.Dispose(); } catch { }
        if(desktop != null)try { desktop.WaitForExit(3000); desktop.Dispose(); } catch { }
        lock(pipeLock) { if(desktopWriter != null)try { desktopWriter.Dispose(); } catch { } if(desktopPipe != null)try { desktopPipe.Dispose(); } catch { } }
        tray.Visible = false; tray.Dispose(); if(trayIcon != null)trayIcon.Dispose(); dispatcher.Dispose(); base.ExitThreadCore();
    }

    private static JobHandle CreateKillJob(Process process)
    {
        IntPtr handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) return null;
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); info.BasicLimitInformation.LimitFlags = 0x2000;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)); IntPtr ptr = Marshal.AllocHGlobal(length);
        try { Marshal.StructureToPtr(info, ptr, false); if (!SetInformationJobObject(handle, 9, ptr, (uint)length) || !AssignProcessToJobObject(handle, process.Handle)) { CloseHandle(handle); return null; } return new JobHandle(handle); }
        finally { Marshal.FreeHGlobal(ptr); }
    }
    private sealed class JobHandle : IDisposable { private IntPtr h; public JobHandle(IntPtr handle) { h=handle; } public bool Assign(Process process) { return h!=IntPtr.Zero && AssignProcessToJobObject(h,process.Handle); } public void Dispose() { if(h!=IntPtr.Zero){CloseHandle(h);h=IntPtr.Zero;} } }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
}

internal static class Program { [STAThread] private static void Main() { LauncherContext.Run(); } }

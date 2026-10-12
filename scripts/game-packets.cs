// Bounded Windows ETW metadata capture. No packet contents, ETL files or drivers.
// The manifest provider supplies the originating PID IN THE PAYLOAD; header PID
// can be a kernel worker and must never be used to attribute network activity.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace GamePackets {
public sealed class Capture {
    public static string ScriptPath;
    static readonly Guid Provider = new Guid("7dd42a49-5329-4832-8dfd-43d979153a88");
    readonly object gate = new object();
    readonly Dictionary<int, Process> processes = new Dictionary<int, Process>();
    readonly Dictionary<string, Endpoint> endpoints = new Dictionary<string, Endpoint>();
    readonly Dictionary<string, IntPtr> names = new Dictionary<string, IntPtr>();
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    TextWriter output;
    BlockingCollection<string> outputQueue;
    Thread outputThread;
    volatile bool stopping;
    long heartbeat = Stopwatch.GetTimestamp();
    readonly EventRateLimit eventRate = new EventRateLimit();
    string reason = "duration";
    long sentPackets, receivedPackets, sentBytes, receivedBytes, retransmits, unknownEvents, omittedEndpoints, processed, knownEvents, selectedEvents, rejectedTimes;
    uint? eventsLost, buffersLost;
    IntPtr properties = IntPtr.Zero;
    ulong session, consumer = UInt64.MaxValue;
    string sessionName;
    EventCallback callback;
    Thread consumerThread;
    Process cleanupGuard;

    public sealed class Config { public int durationMs; public Identity[] processes; }
    static bool ValidDuration(int durationMs) { return durationMs == 0 || (durationMs >= 1000 && durationMs <= 86400000); }
    static bool WithinDuration(int durationMs, long elapsedMs) { return durationMs == 0 || elapsedMs < durationMs; }
    // Fixed rolling budget bounds work under an event flood, not total match
    // length. Called only by the single ETW consumer callback thread.
    sealed class EventRateLimit {
        long windowMs = -1; int count;
        public bool Accept(long elapsedMs) {
            if (windowMs < 0 || elapsedMs - windowMs >= 10000) { windowMs = elapsedMs; count = 0; }
            return ++count <= 500000;
        }
    }
    readonly Stopwatch eventClock = Stopwatch.StartNew();
    public sealed class Identity { public int pid; public string startedAt; }
    public sealed class Endpoint {
        public string protocol, address; public int port;
        public long sentPackets, receivedPackets, sentBytes, receivedBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct Wnode {
        public uint BufferSize, ProviderId; public ulong HistoricalContext; public long TimeStamp;
        public Guid Guid; public uint ClientContext, Flags;
    }
    [StructLayout(LayoutKind.Sequential)] struct Properties {
        public Wnode Wnode;
        public uint BufferSize, MinimumBuffers, MaximumBuffers, MaximumFileSize, LogFileMode, FlushTimer, EnableFlags;
        public int AgeLimit;
        public uint NumberOfBuffers, FreeBuffers, EventsLost, BuffersWritten, LogBuffersLost, RealTimeBuffersLost;
        public IntPtr LoggerThreadId; public uint LogFileNameOffset, LoggerNameOffset;
    }
    // Native x64 EVENT_TRACE_LOGFILEW. Unused CurrentEvent/LogfileHeader retain
    // their complete native space. SelfTest verifies offsets before any capture.
    [StructLayout(LayoutKind.Explicit, Size = 448)] struct Logfile {
        [FieldOffset(8)] public IntPtr LoggerName;
        [FieldOffset(28)] public uint ProcessTraceMode;
        [FieldOffset(424)] public IntPtr EventRecordCallback;
    }
    [StructLayout(LayoutKind.Sequential)] struct Descriptor {
        public ushort Id; public byte Version, Channel, Level, Opcode; public ushort Task; public ulong Keyword;
    }
    [StructLayout(LayoutKind.Sequential)] struct Header {
        public ushort Size, HeaderType, Flags, EventProperty;
        public uint ThreadId, ProcessId; public long TimeStamp; public Guid ProviderId;
        public Descriptor Descriptor; public ulong ProcessorTime; public Guid ActivityId;
    }
    [StructLayout(LayoutKind.Sequential)] struct PropertyDescriptor {
        public ulong PropertyName; public uint ArrayIndex, Reserved;
    }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void EventCallback(IntPtr record);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint StartTraceW(out ulong handle, string name, IntPtr props);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint ControlTraceW(ulong handle, string name, IntPtr props, uint code);
    [DllImport("advapi32.dll")] static extern uint EnableTraceEx2(ulong handle, ref Guid provider, uint code, byte level, ulong any, ulong all, uint timeout, IntPtr parameters);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ulong OpenTraceW(ref Logfile logfile);
    [DllImport("advapi32.dll")] static extern uint ProcessTrace([In] ulong[] handles, uint count, IntPtr start, IntPtr end);
    [DllImport("advapi32.dll")] static extern uint CloseTrace(ulong handle);
    [DllImport("tdh.dll")] static extern uint TdhGetPropertySize(IntPtr record, uint count, IntPtr context, uint propertyCount, ref PropertyDescriptor descriptor, out uint size);
    [DllImport("tdh.dll")] static extern uint TdhGetProperty(IntPtr record, uint count, IntPtr context, uint propertyCount, ref PropertyDescriptor descriptor, uint size, [Out] byte[] bytes);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);

    static string ReadBounded(TextReader reader, int maximum) {
        StringBuilder line = new StringBuilder();
        int c;
        while ((c = reader.Read()) != -1) {
            if (c == '\n') return line.ToString().TrimEnd('\r');
            if (line.Length >= maximum) throw new InvalidDataException();
            line.Append((char)c);
        }
        return line.Length == 0 ? null : line.ToString();
    }
    void Write(object data) {
        try { if (!outputQueue.TryAdd(json.Serialize(data))) { stopping = true; reason = "controller-lost"; } }
        catch { stopping = true; reason = "controller-lost"; }
    }
    void WriteError(string code) { Write(new { type = "error", code = code }); }
    static void Error(TextWriter writer, string code) {
        try { writer.WriteLine("{\"type\":\"error\",\"code\":\"" + code + "\"}"); writer.Flush(); } catch { }
    }
    public static void Run(TextReader reader, TextWriter writer) {
        Capture capture = new Capture(); capture.output = writer;
        capture.outputQueue = new BlockingCollection<string>(4);
        capture.outputThread = new Thread(delegate() {
            try { foreach (string line in capture.outputQueue.GetConsumingEnumerable()) { writer.WriteLine(line); writer.Flush(); } }
            catch { capture.reason = "controller-lost"; capture.stopping = true; }
        }); capture.outputThread.IsBackground = true; capture.outputThread.Start();
        try { capture.Execute(reader); }
        catch (UnauthorizedAccessException) { capture.WriteError("needs-admin"); }
        catch { capture.WriteError("helper_failed"); }
        finally {
            capture.Cleanup(); capture.outputQueue.CompleteAdding();
            // A blocked stdout/pipe must not keep an ETW session alive.
            capture.outputThread.Join(2000);
        }
    }
    void Execute(TextReader reader) {
        CheckLayout();
        Config config = json.Deserialize<Config>(ReadBounded(reader, 16384));
        if (config == null || !ValidDuration(config.durationMs) || config.processes == null || config.processes.Length == 0 || config.processes.Length > 32)
            throw new InvalidDataException();
        foreach (Identity identity in config.processes) {
            if (identity.pid <= 4 || processes.ContainsKey(identity.pid)) throw new InvalidDataException();
            Process process = null;
            try {
                DateTime expected = DateTime.Parse(identity.startedAt, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime();
                process = Process.GetProcessById(identity.pid);
                // Force handle acquisition and retain it: later PID reuse cannot
                // replace this kernel process object even between polling ticks.
                IntPtr handle = process.Handle;
                if (Math.Abs((process.StartTime.ToUniversalTime() - expected).TotalMilliseconds) >= 1 || WaitForSingleObject(handle, 0) != 258)
                    throw new InvalidDataException();
                processes.Add(identity.pid, process); process = null;
            } catch { WriteError("process-changed"); return; }
            finally { if (process != null) process.Dispose(); }
        }
        Thread input = new Thread(delegate() {
            try {
                string line;
                while ((line = ReadBounded(reader, 32)) != null) {
                    if (line == "stop") { reason = "user"; stopping = true; return; }
                    if (line != "ping") { reason = "invalid-control"; stopping = true; return; }
                    Interlocked.Exchange(ref heartbeat, Stopwatch.GetTimestamp());
                }
            } catch { }
            reason = "controller-lost"; stopping = true;
        }); input.IsBackground = true; input.Start();
        if (stopping) return;
        foreach (string name in new string[] { "PID", "size", "daddr", "saddr", "dport", "sport" }) names.Add(name, Marshal.StringToHGlobalUni(name));
        sessionName = "NetzwerkKompass-Game-" + Guid.NewGuid().ToString("N");
        Guid sessionGuid = Guid.NewGuid();
        // ETW sessions outlive a crashed controller. A separate minimal helper
        // retains our process handle and cleans up ONLY this name + GUID.
        if (!StartGuard(sessionGuid)) { WriteError("guard-unavailable"); return; }
        if (stopping) return;
        int structureSize = Marshal.SizeOf(typeof(Properties));
        Properties props = new Properties();
        props.Wnode.BufferSize = (uint)(structureSize + (sessionName.Length + 1) * 2);
        props.Wnode.Flags = 0x20000; props.Wnode.ClientContext = 1; props.Wnode.Guid = sessionGuid;
        props.BufferSize = 64; props.MinimumBuffers = 4; props.MaximumBuffers = 16;
        props.LogFileMode = 0x100; props.FlushTimer = 1; props.LoggerNameOffset = (uint)structureSize;
        properties = Marshal.AllocHGlobal((int)props.Wnode.BufferSize);
        Marshal.Copy(new byte[props.Wnode.BufferSize], 0, properties, (int)props.Wnode.BufferSize);
        Marshal.StructureToPtr(props, properties, false);
        uint result = StartTraceW(out session, sessionName, properties);
        if (result != 0) { session = 0; WriteError(result == 5 ? "needs-admin" : "session-start-failed"); return; }
        Guid provider = Provider;
        result = EnableTraceEx2(session, ref provider, 1, 4, 0x30, 0, 0, IntPtr.Zero);
        if (result != 0) { WriteError(result == 5 ? "needs-admin" : "provider-unavailable"); return; }
        callback = OnEvent;
        IntPtr logger = Marshal.StringToHGlobalUni(sessionName);
        try {
            Logfile logfile = new Logfile(); logfile.LoggerName = logger; logfile.ProcessTraceMode = 0x10000100;
            logfile.EventRecordCallback = Marshal.GetFunctionPointerForDelegate(callback);
            consumer = OpenTraceW(ref logfile);
        } finally { Marshal.FreeHGlobal(logger); }
        if (consumer == UInt64.MaxValue) { WriteError(Marshal.GetLastWin32Error() == 5 ? "needs-admin" : "consumer-start-failed"); return; }
        consumerThread = new Thread(delegate() {
            uint status = ProcessTrace(new ulong[] { consumer }, 1, IntPtr.Zero, IntPtr.Zero);
            if (!stopping) { reason = status == 0 ? "consumer-ended" : "consumer-failed"; stopping = true; }
        }); consumerThread.IsBackground = true; consumerThread.Start();
        Write(new { type = "ready", at = DateTime.UtcNow.ToString("o") });
        Stopwatch duration = Stopwatch.StartNew();
        long nextSample = 1000;
        while (!stopping && WithinDuration(config.durationMs, duration.ElapsedMilliseconds)) {
            Thread.Sleep(250);
            if (stopping) break;
            if (Stopwatch.GetTimestamp() - Interlocked.Read(ref heartbeat) > Stopwatch.Frequency * 8) { reason = "controller-lost"; break; }
            bool alive = false;
            foreach (Process process in processes.Values) if (WaitForSingleObject(process.Handle, 0) == 258) alive = true;
            if (!alive) { reason = "process-ended"; break; }
            if (duration.ElapsedMilliseconds >= nextSample) { Emit("sample"); nextSample = duration.ElapsedMilliseconds + 1000; }
        }
        stopping = true;
        StopSession();
        Emit("final");
    }
    byte[] Property(IntPtr record, string name, uint expectedSize) {
        PropertyDescriptor descriptor = new PropertyDescriptor(); descriptor.PropertyName = (ulong)names[name].ToInt64(); descriptor.ArrayIndex = UInt32.MaxValue;
        uint size;
        if (TdhGetPropertySize(record, 0, IntPtr.Zero, 1, ref descriptor, out size) != 0 || size != expectedSize) return null;
        byte[] result = new byte[size];
        return TdhGetProperty(record, 0, IntPtr.Zero, 1, ref descriptor, size, result) == 0 ? result : null;
    }
    void OnEvent(IntPtr record) {
        try {
            Header header = (Header)Marshal.PtrToStructure(record, typeof(Header));
            if (header.ProviderId != Provider) return;
            if (stopping) return;
            Interlocked.Increment(ref processed);
            if (!eventRate.Accept(eventClock.ElapsedMilliseconds)) { reason = "event-limit"; stopping = true; return; }
            int id = header.Descriptor.Id;
            bool send = id == 10 || id == 26 || id == 42 || id == 58;
            bool receive = id == 11 || id == 27 || id == 43 || id == 59;
            bool retransmit = id == 14 || id == 30;
            if (!send && !receive && !retransmit) return;
            Interlocked.Increment(ref knownEvents);
            if (header.Descriptor.Version != 0) { lock (gate) unknownEvents++; return; }
            byte[] pidBytes = Property(record, "PID", 4);
            if (pidBytes == null) { lock (gate) unknownEvents++; return; }
            int pid = (int)BitConverter.ToUInt32(pidBytes, 0);
            Process process;
            if (!processes.TryGetValue(pid, out process)) return;
            Interlocked.Increment(ref selectedEvents);
            // Keep delayed records only inside the exact lifetime of the held
            // process object. A reused numeric PID cannot cross these bounds.
            if (header.TimeStamp < process.StartTime.ToUniversalTime().ToFileTimeUtc()) { Interlocked.Increment(ref rejectedTimes); return; }
            if (WaitForSingleObject(process.Handle, 0) != 258 && header.TimeStamp >= process.ExitTime.ToUniversalTime().ToFileTimeUtc()) { Interlocked.Increment(ref rejectedTimes); return; }
            if (retransmit) { lock (gate) retransmits++; return; }
            bool ipv6 = id == 26 || id == 27 || id == 58 || id == 59;
            byte[] size = Property(record, "size", 4);
            byte[] address = Property(record, send ? "daddr" : "saddr", ipv6 ? 16U : 4U);
            byte[] port = Property(record, send ? "dport" : "sport", 2);
            if (size == null || address == null || port == null) { lock (gate) unknownEvents++; return; }
            string protocol = id >= 42 ? "UDP" : "TCP";
            string remote = new IPAddress(address).ToString();
            int remotePort = ((int)port[0] << 8) | port[1];
            long bytes = BitConverter.ToUInt32(size, 0);
            lock (gate) {
                if (send) { sentPackets++; sentBytes += bytes; } else { receivedPackets++; receivedBytes += bytes; }
                string key = protocol + "/" + remote + "/" + remotePort;
                Endpoint endpoint;
                if (!endpoints.TryGetValue(key, out endpoint)) {
                    if (endpoints.Count >= 64) { omittedEndpoints++; return; }
                    endpoint = new Endpoint { protocol = protocol, address = remote, port = remotePort }; endpoints.Add(key, endpoint);
                }
                if (send) { endpoint.sentPackets++; endpoint.sentBytes += bytes; } else { endpoint.receivedPackets++; endpoint.receivedBytes += bytes; }
            }
        } catch { lock (gate) unknownEvents++; }
    }
    void Emit(string type) {
        if (session != 0) {
            if (ControlTraceW(session, sessionName, properties, 0) == 0) ReadLosses();
            else { eventsLost = null; buffersLost = null; }
        }
        lock (gate) Write(new { type = type, at = DateTime.UtcNow.ToString("o"), sentPackets = sentPackets, receivedPackets = receivedPackets,
            sentBytes = sentBytes, receivedBytes = receivedBytes, retransmits = retransmits, unknownEvents = unknownEvents,
            omittedEndpoints = omittedEndpoints, endpoints = new List<Endpoint>(endpoints.Values),
            losses = new { events = eventsLost, buffers = buffersLost }, reason = reason,
            diagnostics = new { providerEvents = Interlocked.Read(ref processed), knownNetworkEvents = Interlocked.Read(ref knownEvents),
                selectedProcessEvents = Interlocked.Read(ref selectedEvents), rejectedTimestamps = Interlocked.Read(ref rejectedTimes) } });
    }
    void ReadLosses() {
        Properties props = (Properties)Marshal.PtrToStructure(properties, typeof(Properties));
        eventsLost = props.EventsLost; buffersLost = props.RealTimeBuffersLost;
    }
    void StopSession() {
        if (session != 0) {
            Guid provider = Provider;
            EnableTraceEx2(session, ref provider, 0, 0, 0, 0, 0, IntPtr.Zero);
            uint stopped = ControlTraceW(session, sessionName, properties, 1);
            if (stopped == 0) { ReadLosses(); session = 0; }
            else if (stopped == 4201) session = 0; // Session already gone.
            else { reason = "cleanup-failed"; eventsLost = null; buffersLost = null; }
        }
        if (consumerThread != null && !consumerThread.Join(3000) && consumer != UInt64.MaxValue) {
            CloseTrace(consumer); consumer = UInt64.MaxValue;
        }
        if (consumer != UInt64.MaxValue) { CloseTrace(consumer); consumer = UInt64.MaxValue; }
        if (consumerThread != null) consumerThread.Join(1000);
    }
    void Cleanup() {
        stopping = true; StopSession();
        foreach (Process process in processes.Values) process.Dispose();
        foreach (IntPtr name in names.Values) Marshal.FreeHGlobal(name);
        if (properties != IntPtr.Zero) { Marshal.FreeHGlobal(properties); properties = IntPtr.Zero; }
        if (cleanupGuard != null) { cleanupGuard.Dispose(); cleanupGuard = null; }
        GC.KeepAlive(callback);
    }
    bool StartGuard(Guid sessionGuid) {
        try {
            if (String.IsNullOrEmpty(ScriptPath) || !Path.IsPathRooted(ScriptPath)) return false;
            ProcessStartInfo info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe"));
            info.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + ScriptPath.Replace("\"", "") +
                "\" -GuardSession " + sessionName + " -GuardSessionGuid " + sessionGuid.ToString("D") + " -GuardOwnerPid " + Process.GetCurrentProcess().Id;
            info.UseShellExecute = false; info.CreateNoWindow = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            cleanupGuard = Process.Start(info);
            var ready = cleanupGuard.StandardOutput.ReadLineAsync();
            if (!ready.Wait(15000) || ready.Result != "guard-ready") return false;
            return true;
        } catch { return false; }
    }
    public static void Guard(string name, string guidText, int ownerPid) {
        Guid expected;
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^NetzwerkKompass-Game-[a-f0-9]{32}$") || !Guid.TryParse(guidText, out expected) || ownerPid <= 4) return;
        Process owner;
        try { owner = Process.GetProcessById(ownerPid); IntPtr retainedHandle = owner.Handle; }
        catch { return; }
        using (owner) {
            Console.WriteLine("guard-ready"); Console.Out.Flush();
            // The retained kernel process handle prevents PID reuse. Healthy
            // captures can last an entire match; cleanup begins when its owner
            // exits, including a crash, regardless of match length.
            while (WaitForSingleObject(owner.Handle, 500) == 258) { }
            IntPtr memory = Marshal.AllocHGlobal(1024);
            try {
                Properties query = new Properties(); query.Wnode.BufferSize = 1024; query.LoggerNameOffset = (uint)Marshal.SizeOf(typeof(Properties));
                Marshal.Copy(new byte[1024], 0, memory, 1024); Marshal.StructureToPtr(query, memory, false);
                if (ControlTraceW(0, name, memory, 0) != 0) return;
                Properties found = (Properties)Marshal.PtrToStructure(memory, typeof(Properties));
                if (found.Wnode.Guid == expected) ControlTraceW(0, name, memory, 1);
            } finally { Marshal.FreeHGlobal(memory); }
        }
    }
    static void CheckLayout() {
        if (IntPtr.Size != 8 || Marshal.SizeOf(typeof(Header)) != 80 || Marshal.SizeOf(typeof(Properties)) != 120 || Marshal.SizeOf(typeof(Logfile)) != 448)
            throw new PlatformNotSupportedException();
    }
    public static void SelfTest() {
        CheckLayout();
        SelfTestDuplex();
        if (!ValidDuration(0) || !ValidDuration(1200000) || !ValidDuration(86400000) || ValidDuration(-1) || ValidDuration(999) || ValidDuration(86400001))
            throw new Exception("Capture duration validation failed");
        if (!WithinDuration(0, 172800000L) || !WithinDuration(1200000, 1199999) || WithinDuration(1200000, 1200000))
            throw new Exception("Match lifetime is incorrectly limited");
        EventRateLimit rate = new EventRateLimit();
        for (int window = 0; window < 12; window++)
            for (int i = 0; i < 500000; i++) if (!rate.Accept(window * 10000L)) throw new Exception("Lifetime event cap remains");
        if (rate.Accept(110000)) throw new Exception("Event flood is not bounded");
        if (!rate.Accept(120000)) throw new Exception("Event budget does not recover in a new window");
        if (ReadBounded(new StringReader("ping\nstop\r\n"), 32) != "ping") throw new Exception();
        bool bounded = false;
        try { ReadBounded(new StringReader(new string('x', 40)), 32); } catch (InvalidDataException) { bounded = true; }
        if (!bounded) throw new Exception("Unbounded input");
        Capture capture = new Capture(); capture.output = TextWriter.Null;
        try {
            Process current = Process.GetCurrentProcess();
            IntPtr handle = current.Handle;
            capture.processes.Add(current.Id, current);
            foreach (string name in new string[] { "PID", "size", "daddr", "saddr", "dport", "sport" }) capture.names.Add(name, Marshal.StringToHGlobalUni(name));
            foreach (int id in new int[] { 10, 11, 26, 27, 42, 43, 58, 59 }) capture.Fixture(id, current.Id, 0, DateTime.UtcNow.ToFileTimeUtc());
            if (capture.sentPackets != 4 || capture.receivedPackets != 4 || capture.sentBytes != 492 || capture.receivedBytes != 492 || capture.unknownEvents != 0)
                throw new Exception("Manifest metadata decoding failed");
            foreach (Endpoint endpoint in capture.endpoints.Values)
                if (endpoint.port != 443 || (endpoint.address != "203.0.113.8" && endpoint.address != "2001:db8::8")) throw new Exception("Endpoint orientation or byte order failed");
            capture.Fixture(10, Int32.MaxValue, 0, DateTime.UtcNow.ToFileTimeUtc());
            capture.Fixture(10, current.Id, 0, current.StartTime.ToUniversalTime().AddSeconds(-1).ToFileTimeUtc());
            capture.Fixture(14, current.Id, 0, DateTime.UtcNow.ToFileTimeUtc());
            capture.Fixture(10, current.Id, 1, DateTime.UtcNow.ToFileTimeUtc());
            if (capture.sentPackets != 4 || capture.retransmits != 1 || capture.unknownEvents != 1) throw new Exception("PID, timestamp, version or retransmit guard failed");
            ProcessStartInfo start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"), "/c exit 0");
            start.UseShellExecute = false; start.CreateNoWindow = true;
            Process exited = Process.Start(start); IntPtr retainedHandle = exited.Handle; exited.WaitForExit();
            capture.processes.Add(exited.Id, exited);
            capture.Fixture(10, exited.Id, 0, exited.ExitTime.ToUniversalTime().ToFileTimeUtc() + 1);
            if (capture.sentPackets != 4) throw new Exception("Exited process/PID reuse guard failed");
        } finally { capture.Cleanup(); }
        Console.WriteLine("game-packets native fixtures OK: unlimited/20-minute lifetime and duration validation, six million synthetic events with bounded rate, simultaneous duplex control/output, x64 layout, bounded control, TCP/UDP IPv4/IPv6 TDH decoding, byte order, payload PID, old timestamps, exited-process/PID reuse, unknown schema, retransmits (no ETW session started)");
    }
    void Fixture(int id, int pid, byte version, long timestamp) {
        bool ipv6 = id == 26 || id == 27 || id == 58 || id == 59;
        bool receive = id == 11 || id == 27 || id == 43 || id == 59;
        byte[] remote = IPAddress.Parse(ipv6 ? "2001:db8::8" : "203.0.113.8").GetAddressBytes();
        byte[] local = IPAddress.Parse(ipv6 ? "2001:db8::1" : "192.0.2.1").GetAddressBytes();
        MemoryStream bytes = new MemoryStream(); BinaryWriter writer = new BinaryWriter(bytes);
        writer.Write(pid); writer.Write(123U); writer.Write(receive ? local : remote); writer.Write(receive ? remote : local);
        writer.Write(receive ? new byte[] { 0xc0, 0x01, 0x01, 0xbb } : new byte[] { 0x01, 0xbb, 0xc0, 0x01 });
        writer.Write(new byte[16]); byte[] payload = bytes.ToArray();
        IntPtr data = Marshal.AllocHGlobal(payload.Length), record = Marshal.AllocHGlobal(112);
        try {
            Marshal.Copy(payload, 0, data, payload.Length); Marshal.Copy(new byte[112], 0, record, 112);
            Header header = new Header(); header.Size = 80; header.Flags = 0x40; header.ProviderId = Provider; header.TimeStamp = timestamp;
            header.ProcessId = 4; header.Descriptor.Id = (ushort)id; header.Descriptor.Version = version;
            header.Descriptor.Task = (ushort)(id >= 42 ? 11 : 10); header.Descriptor.Level = 4;
            header.Descriptor.Opcode = (byte)(id == 26 ? 10 : id == 27 ? 11 : id == 58 ? 42 : id == 59 ? 43 : id);
            Marshal.StructureToPtr(header, record, false); Marshal.WriteInt16(record, 86, (short)payload.Length); Marshal.WriteIntPtr(record, 96, data);
            OnEvent(record);
        } finally { Marshal.FreeHGlobal(record); Marshal.FreeHGlobal(data); writer.Dispose(); bytes.Dispose(); }
    }
    // UAC elevates this capture helper only. A per-user random local pipe passes
    // the fixed config/control protocol; it cannot carry executable commands.
    static NamedPipeClientStream OpenClient(string name) {
        // Both ends require overlapped handles: a pending synchronous read on
        // the control channel otherwise blocks concurrent sample/final writes.
        return new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
    }
    static void SelfTestDuplex() {
        string name = "PacketPipeFixture-" + Guid.NewGuid().ToString("N");
        using (NamedPipeServerStream server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
        using (NamedPipeClientStream client = OpenClient(name)) {
            var connection = server.BeginWaitForConnection(null, null); client.Connect(1000); server.EndWaitForConnection(connection);
            if (!client.IsAsync) throw new Exception("Duplex client requires overlapped IO");
            byte[] control = new byte[1], sample = new byte[1];
            var blockedControl = client.ReadAsync(control, 0, 1);
            var sampleRead = server.ReadAsync(sample, 0, 1);
            client.WriteByte(42); client.Flush();
            bool independentOutput = sampleRead.Wait(1000) && sample[0] == 42;
            server.WriteByte(1); server.Flush();
            if (!blockedControl.Wait(1000) || !independentOutput) throw new Exception("Control read blocks sample/final output");
        }
    }
    public static void Connect(string pipeName) {
        if (!System.Text.RegularExpressions.Regex.IsMatch(pipeName, "^NetzwerkKompass-Game-[a-f0-9]{32}$")) return;
        using (NamedPipeClientStream pipe = OpenClient(pipeName)) {
            try { pipe.Connect(10000); } catch { return; }
            using (StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true))
            using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true)) Run(reader, writer);
        }
    }
    public static void Bridge(string scriptPath) {
        string config;
        try { config = ReadBounded(Console.In, 16384); } catch { Error(Console.Out, "invalid-config"); return; }
        if (config == null) return;
        string pipeName = "NetzwerkKompass-Game-" + Guid.NewGuid().ToString("N");
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        using (NamedPipeServerStream pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, security)) {
            Process child = null;
            object controlGate = new object(); bool cancelled = false; StreamWriter activeWriter = null;
            // Read cancellation before asking UAC. A late UAC acceptance after
            // Stop must never start a capture, even briefly.
            Thread input = new Thread(delegate() {
                try {
                    string line;
                    while ((line = ReadBounded(Console.In, 32)) != null) {
                        lock (controlGate) {
                            if (line != "ping") { cancelled = true; if (activeWriter != null) activeWriter.WriteLine("stop"); return; }
                            if (activeWriter != null) activeWriter.WriteLine("ping");
                        }
                    }
                } catch { }
                lock (controlGate) { cancelled = true; try { if (activeWriter != null) activeWriter.WriteLine("stop"); } catch { } }
            }); input.IsBackground = true; input.Start();
            try {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe");
                info.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + scriptPath.Replace("\"", "") + "\" -ElevatedPipe " + pipeName;
                info.UseShellExecute = true; info.Verb = "runas"; info.WindowStyle = ProcessWindowStyle.Hidden;
                IAsyncResult connection = pipe.BeginWaitForConnection(null, null);
                child = Process.Start(info);
                Stopwatch wait = Stopwatch.StartNew();
                while (!connection.AsyncWaitHandle.WaitOne(250)) {
                    lock (controlGate) { if (cancelled) return; }
                    if (wait.ElapsedMilliseconds > 30000) { Error(Console.Out, "uac-timeout"); return; }
                }
                pipe.EndWaitForConnection(connection);
                uint clientPid;
                if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out clientPid) || child == null || clientPid != child.Id) { Error(Console.Out, "helper_failed"); return; }
                using (StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true))
                using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true)) {
                    lock (controlGate) { if (cancelled) return; writer.AutoFlush = true; writer.WriteLine(config); activeWriter = writer; }
                    string record;
                    while ((record = ReadBounded(reader, 65536)) != null) { Console.Out.WriteLine(record); Console.Out.Flush(); }
                    lock (controlGate) activeWriter = null;
                }
            } catch (System.ComponentModel.Win32Exception exception) { Error(Console.Out, exception.NativeErrorCode == 1223 ? "uac-cancelled" : "needs-admin"); }
            catch { Error(Console.Out, "helper_failed"); }
            finally { if (child != null) child.Dispose(); }
        }
    }
}
}

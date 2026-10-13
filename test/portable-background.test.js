import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../lib/probes.js';

const compiler = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const nodeFixture = String.raw`
using System;
internal static class NodeFixture {
  private static int Main() {
    Console.WriteLine("http://127.0.0.1:44001"); Console.Out.Flush();
    string line;
    while((line = Console.ReadLine()) != null) { if(line == "crash")return 1; if(line.StartsWith("shutdown"))return 0; }
    return 0;
  }
}`;
const desktopFixture = String.raw`
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
internal static class DesktopFixture {
  private static int Main() {
    using(var pipe = new NamedPipeClientStream(".",Environment.GetEnvironmentVariable("NETZWERK_KOMPASS_CONTROL_PIPE"),PipeDirection.InOut)) {
      pipe.Connect(5000);
      using(var writer = new StreamWriter(pipe,new UTF8Encoding(false),1024,true))
      using(var reader = new StreamReader(pipe,Encoding.UTF8,false,1024,true)) {
        writer.AutoFlush = true; writer.WriteLine("DESKTOP_READY");
        string line;
        while((line = reader.ReadLine()) != null)if(line == "shutdown")return 0;
      }
    }
    return 0;
  }
}`;
const harness = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
internal static class BackgroundRegression {
  private static readonly BindingFlags Flags = BindingFlags.Instance | BindingFlags.NonPublic;
  private static object Get(Type type,object context,string field) { return type.GetField(field,Flags).GetValue(context); }
  private static void Pump(Func<bool> done) {
    var clock = Stopwatch.StartNew();
    while(!done()) { if(clock.ElapsedMilliseconds > 10000)throw new Exception("fixture deadline"); Application.DoEvents(); Thread.Sleep(5); }
  }
  private static bool Alive(int id) { try { using(var p=Process.GetProcessById(id))return !p.HasExited; } catch(ArgumentException) { return false; } }
  [STAThread] private static int Main(string[] args) {
    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
    var type = Assembly.LoadFrom(args[0]).GetType("LauncherContext",true);
    string directory = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Netzwerk-Kompass-Daten",".desktop");
    Directory.CreateDirectory(directory);
    bool enabled = args[1] == "enabled";
    File.WriteAllText(Path.Combine(directory,"background.json"),"{\"enabled\":"+(enabled?"true":"false")+"}");
    object context = type.GetConstructor(Flags,null,new[] { typeof(string),typeof(bool) },null).Invoke(new object[] { args[2],true });
    try {
      type.GetMethod("StartNode",Flags).Invoke(context,null);
      Pump(delegate { return (bool)Get(type,context,"ready"); });
      int rounds = enabled ? 4 : 1;
      for(int i=0;i<rounds;i++) {
        var node=(Process)Get(type,context,"node"); var desktop=(Process)Get(type,context,"desktop");
        int nodeId=node.Id,desktopId=desktop.Id;
        node.StandardInput.WriteLine("crash"); node.StandardInput.Flush();
        if(enabled && i<3) {
          int expected=i+1;
          Pump(delegate { return (int)Get(type,context,"backgroundRestarts") == expected && (bool)Get(type,context,"ready"); });
          if(Alive(nodeId) || Alive(desktopId))throw new Exception("duplicate old-generation child");
          if(((Process)Get(type,context,"node")).Id == nodeId)throw new Exception("no replacement node");
        } else {
          Pump(delegate { return (bool)Get(type,context,"closing"); });
          if(Alive(nodeId) || Alive(desktopId))throw new Exception("quit did not reap children");
        }
      }
      if((int)Get(type,context,"backgroundRestarts") != (enabled?3:0))throw new Exception("restart bound violated");
      if(enabled) {
        string log=File.ReadAllText(Path.Combine(directory,"background.log"));
        if(log.Split(new[] { "MONITOR_GAP " },StringSplitOptions.None).Length != 5)throw new Exception("missing gap");
        if(log.Split(new[] { "MONITOR_RESUMED " },StringSplitOptions.None).Length != 4)throw new Exception("missing recovery");
        if(!File.ReadAllText(Path.Combine(directory,"background-runtime.json")).Contains("failed"))throw new Exception("missing exhausted status");
      }
      Console.WriteLine("portable background " + args[1] + " passed");
      return 0;
    } finally { ((ApplicationContext)context).ExitThread(); }
  }
}`;

test('compiled portable opt-in recovery reaps both processes, logs gaps, respects bound; opt-out exits', { skip: process.platform !== 'win32' || !existsSync(compiler), timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'portable-background-'));
  try {
    const app = path.join(directory, 'payload');
    await mkdir(path.join(app, 'runtime/electron'), { recursive: true });
    const files = { node: path.join(directory, 'node.cs'), desktop: path.join(directory, 'desktop.cs'), harness: path.join(directory, 'harness.cs') };
    await Promise.all([writeFile(files.node, nodeFixture), writeFile(files.desktop, desktopFixture), writeFile(files.harness, harness)]);
    const library = path.join(directory, 'launcher.dll'), executable = path.join(directory, 'check.exe');
    const commands = [
      ['/target:library', `/out:${library}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', fileURLToPath(new URL('../scripts/portable-launcher.cs', import.meta.url))],
      ['/target:exe', `/out:${path.join(app, 'runtime/node.exe')}`, files.node],
      ['/target:exe', `/out:${path.join(app, 'runtime/electron/Netzwerk-Kompass-Desktop.exe')}`, files.desktop],
      ['/target:exe', `/out:${executable}`, '/reference:System.Windows.Forms.dll', files.harness]
    ];
    for (const args of commands) {
      const built = await runProcess(compiler, ['/nologo', '/platform:x64', ...args], { timeoutMs: 10000 });
      assert.equal(built.code, 0, built.stdout + built.stderr);
    }
    for (const mode of ['enabled', 'disabled']) {
      const checked = await runProcess(executable, [library, mode, app, '--hidden-window'], { timeoutMs: 20000 });
      assert.equal(checked.code, 0, checked.stdout + checked.stderr);
      assert.match(checked.stdout, new RegExp(`portable background ${mode} passed`));
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('portable-background-'));
    await rm(directory, { recursive: true, force: true });
  }
});

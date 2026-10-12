import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../lib/probes.js';

const compiler = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const source = fileURLToPath(new URL('../scripts/portable-launcher.cs', import.meta.url));

// Compile the actual launcher into a library; do not start the product, its
// payload, Electron, Node server, tray, capture helper or any UAC workflow.
const harness = String.raw`
using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class RaceRegression
{
    private static readonly BindingFlags Fields = BindingFlags.Instance | BindingFlags.NonPublic;
    private static void Set(Type type, object context, string name, object value)
    {
        type.GetField(name, Fields).SetValue(context, value);
    }
    private static EventHandler Handler(Type type, object context, string name)
    {
        return (EventHandler)Delegate.CreateDelegate(typeof(EventHandler), context, type.GetMethod(name, Fields));
    }
    [STAThread]
    private static int Main(string[] args)
    {
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        var type = Assembly.LoadFrom(args[0]).GetType("LauncherContext", true);
        foreach (string name in new[] { "NodeExited", "DesktopExited" }) {
            // An event already queued while open must not touch the Process
            // after shutdown marks closing and disposes it, before UI dispatch.
            object queued = FormatterServices.GetUninitializedObject(type);
            using (var dispatcher = new Control()) {
                IntPtr handle = dispatcher.Handle;
                Set(type, queued, "dispatcher", dispatcher);
                var process = Process.GetCurrentProcess();
                Set(type, queued, "node", process); Set(type, queued, "desktop", process);
                var exited = Handler(type, queued, name);
                Exception failure = null;
                var callback = new Thread(delegate() { try { exited(process, EventArgs.Empty); } catch (Exception ex) { failure = ex; } });
                callback.Start(); callback.Join();
                if (failure != null) throw new Exception("Callback read process before dispatch: " + name, failure);
                Set(type, queued, "closing", true);
                process.Dispose();
                Application.DoEvents();
                // Callbacks racing after disposal must also be harmless.
                Parallel.For(0, 1000, delegate(int i) { exited(process, EventArgs.Empty); });
            }
            // A callback queued after dispatcher disposal must not dereference
            // either the closed UI control or the disposed child Process.
            object closed = FormatterServices.GetUninitializedObject(type);
            var disposed = Process.GetCurrentProcess(); disposed.Dispose();
            var closedControl = new Control(); closedControl.Dispose();
            Set(type, closed, "dispatcher", closedControl);
            Set(type, closed, "node", disposed); Set(type, closed, "desktop", disposed);
            Set(type, closed, "closing", true);
            var late = Handler(type, closed, name);
            Parallel.For(0, 1000, delegate(int i) { late(disposed, EventArgs.Empty); });
        }
        Console.WriteLine("launcher exit/dispose regression passed");
        return 0;
    }
}
`;

test('compiled launcher exit callbacks are safe when child disposal overtakes UI dispatch', { skip: process.platform !== 'win32' || !existsSync(compiler), timeout:30000 }, async()=>{
  const directory = await mkdtemp(path.join(os.tmpdir(), 'launcher-race-test-'));
  try {
    const library = path.join(directory, 'launcher.dll'), cs = path.join(directory, 'race.cs'), executable = path.join(directory, 'race.exe');
    await writeFile(cs,harness);
    const built = await runProcess(compiler,['/nologo','/target:library','/platform:x64',`/out:${library}`,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll',source],{timeoutMs:10000});
    assert.equal(built.code,0,built.stdout+'\n'+built.stderr);
    const compiled = await runProcess(compiler,['/nologo','/target:exe','/platform:x64',`/out:${executable}`,'/reference:System.Windows.Forms.dll',cs],{timeoutMs:10000});
    assert.equal(compiled.code,0,compiled.stdout+'\n'+compiled.stderr);
    const checked = await runProcess(executable,[library],{timeoutMs:10000});
    assert.equal(checked.code,0,checked.stdout+'\n'+checked.stderr);
    assert.match(checked.stdout,/launcher exit\/dispose regression passed/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('launcher-race-test-'));
    await rm(directory,{recursive:true,force:true});
  }
});

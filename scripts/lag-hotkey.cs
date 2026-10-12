// Observes only one chosen shortcut. Every input always continues to Windows.
// No admin, drivers, key log, executable commands or persisted input stream.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace LagHotkey {
public sealed class Observer {
    delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct KeyInput { public uint vk, scan, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int x,y; public uint data,flags,time; public IntPtr extra; }
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    static readonly string[] ModifierNames = {"Control","Alt","Shift","Super"};
    static readonly Dictionary<string,int> Keys = new Dictionary<string,int> {
        {"Backspace",8},{"Tab",9},{"Enter",13},{"NumpadEnter",13},{"Shift",16},{"Control",17},{"Alt",18},{"Pause",19},{"CapsLock",20},
        {"Escape",27},{"Space",32},{"PageUp",33},{"PageDown",34},{"End",35},{"Home",36},{"Left",37},{"Up",38},{"Right",39},{"Down",40},
        {"PrintScreen",44},{"Insert",45},{"Delete",46},{"Super",91},{"SuperLeft",91},{"SuperRight",92},{"Apps",93},
        {"NumLock",144},{"ScrollLock",145},{"ShiftLeft",160},{"ShiftRight",161},{"ControlLeft",162},{"ControlRight",163},{"AltLeft",164},{"AltRight",165},
        {"VolumeMute",173},{"VolumeDown",174},{"VolumeUp",175},{"MediaNextTrack",176},{"MediaPreviousTrack",177},{"MediaStop",178},{"MediaPlayPause",179}
    };
    public sealed class Config { public string binding; }
    public sealed class Binding {
        public string key; public int vk,mods;
        public static Binding Parse(string text) {
            if (text == "") return null;
            if (text == null || text.Length > 80) throw new InvalidDataException();
            string[] parts=text.Split('+'); Binding result=new Binding(); result.key=parts[parts.Length-1];
            for(int i=0;i<parts.Length-1;i++) {
                int index=Array.IndexOf(ModifierNames,parts[i]);
                if(index<0||(result.mods&(1<<index))!=0) throw new InvalidDataException(); result.mods|=1<<index;
            }
            if(result.key=="MouseLeft"||result.key=="MouseRight"||result.key=="MouseMiddle"||result.key=="MouseBack"||result.key=="MouseForward"||
               result.key=="WheelUp"||result.key=="WheelDown"||result.key=="WheelLeft"||result.key=="WheelRight") return result;
            if(Keys.TryGetValue(result.key,out result.vk)) return result;
            if(result.key.Length==1&&((result.key[0]>='A'&&result.key[0]<='Z')||(result.key[0]>='0'&&result.key[0]<='9'))) { result.vk=result.key[0];return result; }
            int value;
            if(result.key.StartsWith("F")&&Int32.TryParse(result.key.Substring(1),out value)&&value>=1&&value<=24&&result.key=="F"+value) { result.vk=111+value; return result; }
            if(result.key.Length==5&&result.key.StartsWith("VK_")&&Int32.TryParse(result.key.Substring(3),System.Globalization.NumberStyles.HexNumber,null,out value)&&value>=8&&value<=254&&result.key=="VK_"+value.ToString("X2")) { result.vk=value;return result; }
            throw new InvalidDataException();
        }
    }
    // This state machine can be verified without installing hooks or reading
    // any real input. Only explicit one-shot recording publishes a binding.
    public sealed class Matcher {
        readonly bool[] held=new bool[256]; readonly Binding binding; readonly Action mark; readonly Action<string> selected;
        public int mods; public bool capturing; long lastMark=Int64.MinValue/2;
        public Matcher(string text,Action marker,Action<string> selection) { binding=Binding.Parse(text);mark=marker;selected=selection; }
        static int Group(int vk) { return vk==16||vk==160||vk==161?4:vk==17||vk==162||vk==163?1:vk==18||vk==164||vk==165?2:vk==91||vk==92?8:0; }
        public void SeedModifier(int vk) { int group=Group(vk);if(group!=0){held[vk]=true;mods|=group;} }
        static string KeyName(int vk,bool extended) {
            if(vk==13&&extended)return "NumpadEnter";
            if((vk>=48&&vk<=57)||(vk>=65&&vk<=90))return ((char)vk).ToString();
            if(vk>=112&&vk<=135)return "F"+(vk-111);
            foreach(var pair in Keys)if(pair.Value==vk&&pair.Key!="NumpadEnter"&&pair.Key!="Super")return pair.Key;
            return "VK_"+vk.ToString("X2");
        }
        void Select(string key,int mask) {
            capturing=false;StringBuilder text=new StringBuilder();
            for(int i=0;i<4;i++)if((mask&(1<<i))!=0)text.Append(ModifierNames[i]+"+");text.Append(key);selected(text.ToString());
        }
        void Match(string key,int vk,bool extended,int mask,long ms) {
            if(binding==null||binding.mods!=mask)return;
            bool same=vk==0?binding.key==key:binding.vk==vk;
            if(binding!=null&&binding.key=="Control")same=Group(vk)==1;
            if(binding!=null&&binding.key=="Alt")same=Group(vk)==2;
            if(binding!=null&&binding.key=="Shift")same=Group(vk)==4;
            if(binding!=null&&binding.key=="Super")same=Group(vk)==8;
            if(vk==13&&binding.vk==13)same=binding.key=="NumpadEnter"?extended:!extended;
            if(!same||ms-lastMark<1000)return;lastMark=ms;mark();
        }
        public void Key(int vk,bool down,bool extended,long ms) {
            if(vk<8||vk>254)return;
            int group=Group(vk);
            if(down) {
                if(held[vk])return;held[vk]=true;if(group!=0)mods|=group;
                if(capturing){if(group==0)Select(KeyName(vk,extended),mods);return;}
                Match(KeyName(vk,extended),vk,extended,mods&~group,ms);
            } else {
                held[vk]=false;
                if(group!=0){int remaining=0;for(int i=8;i<255;i++)if(held[i])remaining|=Group(i);mods=(mods&~group)|(remaining&group);}
                if(capturing&&group!=0)Select(KeyName(vk,extended),mods&~group);
            }
        }
        public void Mouse(string key,long ms) { if(capturing)Select(key,mods);else Match(key,0,false,mods,ms); }
    }
    readonly object gate=new object(); readonly JavaScriptSerializer json=new JavaScriptSerializer {MaxJsonLength=4096};
    readonly BlockingCollection<string> output=new BlockingCollection<string>(8); readonly Stopwatch clock=Stopwatch.StartNew();
    Matcher matcher; volatile bool stopping; long heartbeat=Stopwatch.GetTimestamp();
    IntPtr keyboard,mouse; Hook keyboardCallback,mouseCallback;
    void Send(object value) { lock(gate)if(!output.TryAdd(json.Serialize(value)))stopping=true; }
    static string ReadLine(TextReader reader,int maximum) {
        StringBuilder line=new StringBuilder();int c;
        while((c=reader.Read())!=-1){if(c=='\n')return line.ToString().TrimEnd('\r');if(line.Length>=maximum)throw new InvalidDataException();line.Append((char)c);}return line.Length==0?null:line.ToString();
    }
    IntPtr Keyboard(int code,IntPtr message,IntPtr data) {
        try { if(code>=0&&!stopping) {
            int kind=message.ToInt32();KeyInput input=(KeyInput)Marshal.PtrToStructure(data,typeof(KeyInput));
            if((input.flags&0x10)==0&&(kind==0x100||kind==0x104||kind==0x101||kind==0x105)) {
                int vk=(int)input.vk;if(vk==16)vk=input.scan==54?161:160;else if(vk==17)vk=(input.flags&1)!=0?163:162;else if(vk==18)vk=(input.flags&1)!=0?165:164;
                lock(gate)matcher.Key(vk,kind==0x100||kind==0x104,(input.flags&1)!=0,clock.ElapsedMilliseconds);
            }
        }} catch { stopping=true; }
        return CallNextHookEx(IntPtr.Zero,code,message,data);
    }
    IntPtr Mouse(int code,IntPtr message,IntPtr data) {
        try { if(code>=0&&!stopping) {
            MouseInput input=(MouseInput)Marshal.PtrToStructure(data,typeof(MouseInput));
            if((input.flags&1)==0) {
                int kind=message.ToInt32();string key=kind==0x201?"MouseLeft":kind==0x204?"MouseRight":kind==0x207?"MouseMiddle":null;
                if(kind==0x20b)key=(input.data>>16)==1?"MouseBack":"MouseForward";
                if(kind==0x20a)key=(short)(input.data>>16)>0?"WheelUp":"WheelDown";
                if(kind==0x20e)key=(short)(input.data>>16)>0?"WheelRight":"WheelLeft";
                if(key!=null)lock(gate)matcher.Mouse(key,clock.ElapsedMilliseconds);
            }
        }} catch { stopping=true; }
        return CallNextHookEx(IntPtr.Zero,code,message,data);
    }
    void Execute() {
        Config config=json.Deserialize<Config>(ReadLine(Console.In,4096));if(config==null)throw new InvalidDataException();
        matcher=new Matcher(config.binding,()=>Send(new {type="mark"}),binding=>Send(new {type="selected",accelerator=binding}));
        foreach(int vk in new int[]{160,161,162,163,164,165,91,92})if((GetAsyncKeyState(vk)&0x8000)!=0)matcher.SeedModifier(vk);
        keyboardCallback=Keyboard;mouseCallback=Mouse;
        keyboard=SetWindowsHookEx(13,keyboardCallback,GetModuleHandle(null),0);mouse=SetWindowsHookEx(14,mouseCallback,GetModuleHandle(null),0);
        if(keyboard==IntPtr.Zero||mouse==IntPtr.Zero)throw new InvalidOperationException();
        Thread reader=new Thread(()=>{
            try { string line;while((line=ReadLine(Console.In,32))!=null){
                if(line=="ping")Interlocked.Exchange(ref heartbeat,Stopwatch.GetTimestamp());
                else if(line=="capture"){lock(gate){matcher.capturing=true;Send(new {type="armed"});}}
                else if(line=="cancel"){lock(gate)matcher.capturing=false;}
                else break;
            }}catch {}finally{stopping=true;}
        });reader.IsBackground=true;reader.Start();
        using(var timer=new System.Windows.Forms.Timer()){timer.Interval=1000;timer.Tick+=(sender,args)=>{
            if(stopping||Stopwatch.GetTimestamp()-Interlocked.Read(ref heartbeat)>Stopwatch.Frequency*8){Application.ExitThread();return;}
            Send(new {type="pulse"});
        };timer.Start();Send(new {type="ready"});Application.Run();}
    }
    public static void Run() {
        Observer observer=new Observer();Thread writer=new Thread(()=>{
            try{foreach(string line in observer.output.GetConsumingEnumerable()){Console.Out.WriteLine(line);Console.Out.Flush();}}
            catch{observer.stopping=true;}
        });writer.IsBackground=true;writer.Start();
        try{observer.Execute();}catch{observer.Send(new {type="error"});}
        finally{observer.stopping=true;if(observer.keyboard!=IntPtr.Zero)UnhookWindowsHookEx(observer.keyboard);if(observer.mouse!=IntPtr.Zero)UnhookWindowsHookEx(observer.mouse);observer.output.CompleteAdding();writer.Join(1000);GC.KeepAlive(observer.keyboardCallback);GC.KeepAlive(observer.mouseCallback);}
    }
    public static void SelfTest() {
        if(IntPtr.Size!=8||Marshal.SizeOf(typeof(KeyInput))!=24||Marshal.SizeOf(typeof(MouseInput))!=32)throw new Exception("Native layout");
        int marks=0;string chosen=null;Matcher plain=new Matcher("A",()=>marks++,value=>chosen=value);
        plain.Key(65,true,false,0);plain.Key(65,true,false,1100);plain.Key(65,false,false,1200);plain.Key(65,true,false,1300);
        if(marks!=2)throw new Exception("Repeat/debounce");
        Matcher combo=new Matcher("Control+Alt+L",()=>marks++,value=>chosen=value);combo.Key(162,true,false,0);combo.Key(164,true,false,0);combo.Key(76,true,false,2000);
        if(marks!=3)throw new Exception("Legacy binding");
        foreach(string key in new string[]{"MouseLeft","MouseRight","MouseMiddle","MouseBack","MouseForward","WheelUp","WheelDown","WheelLeft","WheelRight"}){
            Matcher m=new Matcher(key,()=>marks++,value=>chosen=value);int before=marks;m.Mouse(key,0);if(marks!=before+1)throw new Exception("Mouse binding");
            m.capturing=true;m.Mouse(key,2000);if(chosen!=key)throw new Exception("One-shot mouse selection");
        }
        for(int vk=8;vk<=254;vk++){chosen=null;Matcher m=new Matcher("VK_"+vk.ToString("X2"),()=>{},value=>chosen=value);m.capturing=true;m.Key(vk,true,false,0);m.Key(vk,false,false,10);if(chosen==null||Binding.Parse(chosen)==null)throw new Exception("Keyboard selection");}
        Matcher capture=new Matcher("",()=>{},value=>chosen=value);capture.capturing=true;capture.Key(162,true,false,0);capture.Key(9,true,false,1);if(chosen!="Control+Tab")throw new Exception("Modifier capture");
        Matcher seeded=new Matcher("Control+A",()=>marks++,value=>{});seeded.SeedModifier(162);seeded.SeedModifier(163);seeded.Key(162,false,false,0);int beforeSeed=marks;seeded.Key(65,true,false,0);if(marks!=beforeSeed+1)throw new Exception("Held modifier seed");
        capture.capturing=true;capture.Key(27,true,false,2);if(chosen!="Control+Escape")throw new Exception("Escape capture");
        capture.capturing=true;capture.Key(13,true,true,3);if(chosen!="Control+NumpadEnter")throw new Exception("Numpad capture");
        Console.WriteLine("lag-hotkey native self-test OK: all VK keys, legacy combinations, standalone modifiers, Escape/Tab, NumpadEnter, all mouse buttons/wheels, repeat suppression, debounce; no hooks installed and no real input read");
    }
}
}

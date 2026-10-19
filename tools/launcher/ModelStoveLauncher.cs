// model-stove 启动器 —— 双击它就启动本应用。
//
// 为什么需要它(本机实测的坑, 别改回"快捷方式直连 electron.exe"):
//   1) electron 在**标准句柄为空**时会瞬间退出(0x80000003, 一个字都不报)。
//      Explorer 启动快捷方式时句柄就是空的 => 必须由本进程把 electron 的
//      stdout/stderr 接到管道上, 它才肯启动。
//   2) 本机 Chromium 的内部沙箱初始化会失败(同样表现为秒退) => 固定加 --no-sandbox。
//   3) 上面两条都满足时, 加载才正常。启动器随后在后台陪着 electron(保持管道不关闭),
//      应用关掉后自己也退出; 绝不重试, 免得启动出多个实例。
//
// 编译: tools\launcher\build.cmd <应用根目录> [输出exe路径]
//       (构建脚本会把 __APP_DIR__ 替换成实际路径)
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

class ModelStoveLauncher {
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);

    const string app = @"__APP_DIR__";

    [STAThread]
    static void Main() {
        try { ShowWindow(GetConsoleWindow(), 0); } catch { }   // 隐藏自己的控制台窗口
        string log = Path.Combine(app, "logs", "launcher.log");
        string exe = Path.Combine(app, "node_modules", "electron", "dist", "electron.exe");
        Log(log, "==== launch " + DateTime.Now.ToString("HH:mm:ss") + " ====");
        if (!File.Exists(exe)) {
            Log(log, "ERROR electron.exe 不存在: " + exe);
            Msg("electron.exe 不存在:\n" + exe + "\n\n请先在应用目录执行:  npm install");
            return;
        }
        ProcessStartInfo psi = new ProcessStartInfo(exe, "--no-sandbox \"" + app + "\"");
        psi.WorkingDirectory = app;
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;      // 关键: 管道 = 有效标准句柄
        psi.RedirectStandardError = true;
        Process p = new Process(); p.StartInfo = psi;
        StringBuilder tail = new StringBuilder();
        p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) { Log(log, "  OUT " + e.Data); } };
        p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) {
            if (e.Data != null) { Log(log, "  ERR " + e.Data); lock (tail) { tail.AppendLine(e.Data); if (tail.Length > 4000) tail.Remove(0, tail.Length - 4000); } }
        };
        try { p.Start(); } catch (Exception e) { Log(log, "ERROR " + e.Message); Msg("启动失败:\n" + e.Message); return; }
        p.BeginOutputReadLine(); p.BeginErrorReadLine();
        Log(log, "started pid=" + p.Id);
        p.WaitForExit(); p.WaitForExit();
        Log(log, "app exited code=" + p.ExitCode);
    }
    static void Log(string f, string m) { try { File.AppendAllText(f, DateTime.Now.ToString("HH:mm:ss") + "  " + m + Environment.NewLine); } catch { } }
    static void Msg(string m) { try { System.Windows.Forms.MessageBox.Show(m, "Model Stove"); } catch { } }
}
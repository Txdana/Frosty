using System;
using System.Linq;
using System.Windows;
using System.Windows.Threading;

namespace Frosty.Desktop;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        ShutdownMode = ShutdownMode.OnMainWindowClose;
        if (e.Args.Any(arg => string.Equals(arg, "--self-test", StringComparison.OrdinalIgnoreCase)))
        {
            try
            {
                var window = new MainWindow(smokeTest: true);
                MainWindow = window;
                window.Show();
                var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
                timer.Tick += (_, _) =>
                {
                    timer.Stop();
                    try { window.Close(); Environment.ExitCode = 0; Shutdown(0); }
                    catch (Exception ex) { Console.Error.WriteLine(ex); Environment.ExitCode = 1; Shutdown(1); }
                };
                timer.Start();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("Frosty Windows self-test failed: " + ex);
                Environment.ExitCode = 1;
                Shutdown(1);
            }
            return;
        }
        var mainWindow = new MainWindow();
        MainWindow = mainWindow;
        mainWindow.Show();
    }
}

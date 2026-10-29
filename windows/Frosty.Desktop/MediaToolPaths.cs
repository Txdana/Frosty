using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Frosty.Desktop;

/// <summary>Resolves explicit overrides, app-local tools, the reviewed WinGet package cache, then PATH.</summary>
internal static class MediaToolPaths
{
    public static string Ffmpeg => Resolve("ffmpeg", "FROSTY_FFMPEG") ?? throw new FileNotFoundException("FFmpeg was not found. Set FROSTY_FFMPEG or add ffmpeg to PATH.");
    public static string Ffprobe => Resolve("ffprobe", "FROSTY_FFPROBE") ?? throw new FileNotFoundException("FFprobe was not found. Set FROSTY_FFPROBE or add ffprobe to PATH.");
    public static bool HasFfmpeg => Resolve("ffmpeg", "FROSTY_FFMPEG") is not null;
    public static bool HasFfprobe => Resolve("ffprobe", "FROSTY_FFPROBE") is not null;

    private static string? Resolve(string tool, string environmentOverride)
    {
        var explicitPath = Environment.GetEnvironmentVariable(environmentOverride);
        if (!string.IsNullOrWhiteSpace(explicitPath) && File.Exists(explicitPath))
            return Path.GetFullPath(explicitPath);

        var exe = OperatingSystem.IsWindows() ? tool + ".exe" : tool;
        var localCandidates = new List<string>
        {
            Path.Combine(AppContext.BaseDirectory, exe),
            Path.Combine(AppContext.BaseDirectory, "tools", exe),
        };
        if (OperatingSystem.IsWindows())
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (!string.IsNullOrWhiteSpace(localAppData))
                localCandidates.Add(Path.Combine(localAppData, "Microsoft", "WinGet", "Links", exe));
        }
        foreach (var candidate in localCandidates)
            if (File.Exists(candidate)) return Path.GetFullPath(candidate);

        // A WinGet ZIP install can live in its package cache before a shell PATH
        // update reaches this process. Search only Gyan's package directory.
        if (OperatingSystem.IsWindows())
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var packagesRoot = Path.Combine(localAppData, "Microsoft", "WinGet", "Packages");
            try
            {
                if (Directory.Exists(packagesRoot))
                {
                    foreach (var packageDirectory in Directory.EnumerateDirectories(packagesRoot, "Gyan.FFmpeg_*"))
                    {
                        var match = Directory.EnumerateFiles(packageDirectory, exe, SearchOption.AllDirectories).FirstOrDefault();
                        if (!string.IsNullOrWhiteSpace(match)) return Path.GetFullPath(match);
                    }
                }
            }
            catch (Exception) { /* Continue to PATH if the package cache is inaccessible. */ }
        }

        var path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(path)) return null;
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var candidate = Path.Combine(directory.Trim('"'), exe);
                if (File.Exists(candidate)) return Path.GetFullPath(candidate);
                if (!OperatingSystem.IsWindows())
                {
                    candidate = Path.Combine(directory.Trim('"'), tool);
                    if (File.Exists(candidate)) return Path.GetFullPath(candidate);
                }
            }
            catch (Exception) { /* Ignore malformed PATH entries. */ }
        }
        return null;
    }
}

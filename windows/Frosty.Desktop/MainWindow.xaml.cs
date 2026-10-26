using Microsoft.Win32;
using System.Collections.ObjectModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
namespace Frosty.Desktop;
public partial class MainWindow : Window
{
    private IntPtr _project;
    private string? _currentPath;
    private bool _dirty;
    private readonly DispatcherTimer _autosaveTimer;
    private readonly string _recoveryDirectory = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Frosty", "Recovery");
    private readonly ObservableCollection<TrackRow> _tracks = new();
    public MainWindow()
    {
        InitializeComponent();
        TimelineTracks.ItemsSource = _tracks;
        _autosaveTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(60) };
        _autosaveTimer.Tick += (_, _) => CreateRecoverySnapshot();
        _autosaveTimer.Start();
        NewProject();
        TryOfferRecovery();
    }
    private sealed class TrackRow { public string Id { get; init; } = ""; public string Name { get; init; } = ""; public string Type { get; init; } = ""; public int Order { get; init; } public string State { get; init; } = ""; public int ClipCount { get; init; } public bool Locked { get; init; } public bool Muted { get; init; } }
    private static class Native
    {
        private const string Dll = "frosty_core.dll";
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr frosty_project_create();
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode, EntryPoint = "frosty_project_load_w")] internal static extern IntPtr frosty_project_load(string path, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode, EntryPoint = "frosty_project_save_w")] internal static extern int frosty_project_save(IntPtr project, string path, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr frosty_project_summary(IntPtr project);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr frosty_project_json(IntPtr project);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_add_track(IntPtr project, string name, string type, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_set_track_state(IntPtr project, string trackId, string property, int value, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_undo(IntPtr project);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_redo(IntPtr project);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode, EntryPoint = "frosty_project_recovery_snapshot_w")] internal static extern int frosty_project_recovery_snapshot(IntPtr project, string directory, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode, EntryPoint = "frosty_project_recover_latest_w")] internal static extern IntPtr frosty_project_recover_latest(string directory, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr frosty_project_validation(IntPtr project);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern void frosty_project_destroy(IntPtr project);
    }
    private void ReplaceProject(IntPtr project, string? path)
    {
        if (project == IntPtr.Zero) throw new InvalidOperationException("The native engine did not return a project handle.");
        if (_project != IntPtr.Zero) Native.frosty_project_destroy(_project);
        _project = project; _currentPath = path; _dirty = false; UpdateSummary();
    }
    private void NewProject()
    {
        try { ReplaceProject(Native.frosty_project_create(), null); StatusText.Text = "New native project created."; }
        catch (Exception ex) { ProjectSummary.Text = ex.Message; StatusText.Text = "Native engine unavailable. Build frosty_core.dll first."; }
    }
    private static string PtrString(IntPtr ptr) => Marshal.PtrToStringUTF8(ptr) ?? "{}";
    private void UpdateSummary()
    {
        if (_project == IntPtr.Zero) return;
        ProjectSummary.Text = PtrString(Native.frosty_project_summary(_project));
        RefreshTimeline();
        try { using var doc = JsonDocument.Parse(PtrString(Native.frosty_project_validation(_project))); var valid = doc.RootElement.GetProperty("valid").GetBoolean(); StatusText.Text = valid ? (_dirty ? "Unsaved changes" : "Project valid") : "Validation issues detected"; }
        catch { StatusText.Text = "Project loaded; validation status unavailable"; }
        Title = $"Frosty{(_dirty ? " *" : "")} — Native editor";
    }
    private void RefreshTimeline()
    {
        _tracks.Clear();
        try
        {
            using var doc = JsonDocument.Parse(PtrString(Native.frosty_project_json(_project)));
            var root = doc.RootElement;
            if (root.TryGetProperty("settings", out var projectSettings))
            {
                ResolutionText.Text = $"{GetInt(projectSettings, "width")} × {GetInt(projectSettings, "height")}";
                if (projectSettings.TryGetProperty("frameRate", out var fps)) FrameRateText.Text = $"{GetInt(fps, "numerator")} / {GetInt(fps, "denominator")} fps";
                ColorSpaceText.Text = $"{GetString(projectSettings, "colorSpace").ToUpperInvariant()} · {GetString(projectSettings, "colorRange")}";
            }
            if (!root.TryGetProperty("sequences", out var sequences)) return;
            foreach (var sequence in sequences.EnumerateArray())
            {
                var clipCounts = new Dictionary<string, int>();
                if (sequence.TryGetProperty("clips", out var clips)) foreach (var clip in clips.EnumerateArray()) { var id = GetString(clip, "trackId"); if (id.Length > 0) clipCounts[id] = clipCounts.GetValueOrDefault(id) + 1; }
                if (!sequence.TryGetProperty("tracks", out var tracks)) continue;
                foreach (var track in tracks.EnumerateArray())
                {
                    var muted = GetBool(track, "muted"); var solo = GetBool(track, "solo"); var locked = GetBool(track, "locked"); var visible = GetBool(track, "visible", true);
                    var state = string.Join(" · ", new[] { muted ? "Muted" : "", solo ? "Solo" : "", locked ? "Locked" : "", !visible ? "Hidden" : "" }.Where(x => x.Length > 0));
                    _tracks.Add(new TrackRow { Id = GetString(track, "id"), Name = GetString(track, "name"), Type = GetString(track, "type"), Order = GetInt(track, "order"), State = state.Length == 0 ? "Normal" : state, ClipCount = clipCounts.GetValueOrDefault(GetString(track, "id")), Locked = locked, Muted = muted });
                }
                break;
            }
        }
        catch (Exception ex) { StatusText.Text = "Could not render timeline model: " + ex.Message; }
    }
    private static string GetString(JsonElement e, string key) => e.TryGetProperty(key, out var v) ? v.ToString() : "";
    private static int GetInt(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.TryGetInt32(out var n) ? n : 0;
    private static bool GetBool(JsonElement e, string key, bool fallback = false) => e.TryGetProperty(key, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : fallback;
    private void MarkDirty() { _dirty = true; UpdateSummary(); }
    private void NewProject_Click(object sender, RoutedEventArgs e) { if (ConfirmDiscard()) NewProject(); }
    private bool ConfirmDiscard() => !_dirty || MessageBox.Show(this, "Discard unsaved changes? A recovery snapshot may be available.", "Unsaved project", MessageBoxButton.YesNo, MessageBoxImage.Warning) == MessageBoxResult.Yes;
    private void OpenProject_Click(object sender, RoutedEventArgs e)
    {
        if (!ConfirmDiscard()) return;
        var dialog = new OpenFileDialog { Filter = "Frosty project (*.frosty)|*.frosty|JSON project (*.json)|*.json|All files (*.*)|*.*" };
        if (dialog.ShowDialog(this) != true) return;
        try { var error = new StringBuilder(2048); var loaded = Native.frosty_project_load(dialog.FileName, error, error.Capacity); if (loaded == IntPtr.Zero) throw new InvalidOperationException(error.ToString()); ReplaceProject(loaded, dialog.FileName); StatusText.Text = "Loaded and migrated project: " + System.IO.Path.GetFileName(dialog.FileName); }
        catch (Exception ex) { MessageBox.Show(this, ex.Message, "Could not open project", MessageBoxButton.OK, MessageBoxImage.Error); }
    }
    private bool SaveTo(string path)
    {
        var error = new StringBuilder(2048);
        if (Native.frosty_project_save(_project, path, error, error.Capacity) == 0) { MessageBox.Show(this, error.ToString(), "Could not save project", MessageBoxButton.OK, MessageBoxImage.Error); return false; }
        _currentPath = path; _dirty = false; StatusText.Text = "Saved atomically: " + path; UpdateSummary(); return true;
    }
    private void SaveProject_Click(object sender, RoutedEventArgs e) { if (_currentPath is null) SaveAs_Click(sender, e); else SaveTo(_currentPath); }
    private void SaveAs_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new SaveFileDialog { Filter = "Frosty project (*.frosty)|*.frosty", DefaultExt = ".frosty", FileName = "Untitled.frosty" };
        if (dialog.ShowDialog(this) == true) SaveTo(dialog.FileName);
    }
    private void AddVideoTrack_Click(object sender, RoutedEventArgs e) => AddTrack("video");
    private void AddAudioTrack_Click(object sender, RoutedEventArgs e) => AddTrack("audio");
    private void AddTrack(string type)
    {
        var error = new StringBuilder(2048); var name = type == "audio" ? $"A{_tracks.Count(x => x.Type == "audio") + 1}" : $"V{_tracks.Count(x => x.Type == "video") + 1}";
        if (Native.frosty_project_add_track(_project, name, type, error, error.Capacity) == 0) { MessageBox.Show(this, error.ToString(), "Track operation failed", MessageBoxButton.OK, MessageBoxImage.Error); return; }
        MarkDirty(); StatusText.Text = $"Added {type} track {name}.";
    }
    private void ToggleLock_Click(object sender, RoutedEventArgs e) => ToggleSelectedTrackState("locked", row => !row.Locked);
    private void ToggleMute_Click(object sender, RoutedEventArgs e) => ToggleSelectedTrackState("muted", row => !row.Muted);
    private void ToggleSelectedTrackState(string property, Func<TrackRow, bool> next)
    {
        if (TimelineTracks.SelectedItem is not TrackRow row) { StatusText.Text = "Select a track first."; return; }
        var error = new StringBuilder(2048);
        if (Native.frosty_project_set_track_state(_project, row.Id, property, next(row) ? 1 : 0, error, error.Capacity) == 0) { MessageBox.Show(this, error.ToString(), "Track operation failed", MessageBoxButton.OK, MessageBoxImage.Error); return; }
        MarkDirty();
    }
    private void Undo_Click(object sender, RoutedEventArgs e) { if (Native.frosty_project_undo(_project) != 0) MarkDirty(); }
    private void Redo_Click(object sender, RoutedEventArgs e) { if (Native.frosty_project_redo(_project) != 0) MarkDirty(); }
    private void TryOfferRecovery()
    {
        try
        {
            if (!System.IO.Directory.Exists(_recoveryDirectory) || !System.IO.Directory.EnumerateFiles(_recoveryDirectory, "*.frosty").Any()) return;
            if (MessageBox.Show(this, "A recovery snapshot exists from an earlier session. Open the latest recovery snapshot?", "Frosty recovery", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
            var error = new StringBuilder(2048); var recovered = Native.frosty_project_recover_latest(_recoveryDirectory, error, error.Capacity);
            if (recovered == IntPtr.Zero) { MessageBox.Show(this, error.ToString(), "Recovery failed", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
            ReplaceProject(recovered, null); _dirty = true; UpdateSummary(); StatusText.Text = "Recovered unsaved project snapshot. Save it to a project file.";
        }
        catch (Exception ex) { StatusText.Text = "Recovery check failed: " + ex.Message; }
    }
    private void CreateRecoverySnapshot()
    {
        if (_project == IntPtr.Zero || !_dirty) return;
        var error = new StringBuilder(2048);
        if (Native.frosty_project_recovery_snapshot(_project, _recoveryDirectory, error, error.Capacity) != 0) StatusText.Text = "Recovery snapshot saved.";
        else StatusText.Text = "Autosave snapshot failed: " + error;
    }
    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (_dirty)
        {
            CreateRecoverySnapshot();
            var choice = MessageBox.Show(this, "There are unsaved changes. A recovery snapshot has been attempted. Close Frosty anyway?", "Unsaved changes", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (choice != MessageBoxResult.Yes) { e.Cancel = true; return; }
        }
        base.OnClosing(e);
    }
    protected override void OnClosed(EventArgs e) { _autosaveTimer.Stop(); if (_project != IntPtr.Zero) Native.frosty_project_destroy(_project); base.OnClosed(e); }
}

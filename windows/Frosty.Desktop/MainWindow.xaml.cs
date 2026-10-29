using Microsoft.Win32;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
namespace Frosty.Desktop;
public partial class MainWindow : Window
{
    private IntPtr _project;
    private string? _currentPath;
    private bool _dirty;
    private bool _refreshing;
    private double _pendingPreviewSeek;
    private bool _previewPlaying;
    private string? _renderedPreviewPath;
    private readonly DispatcherTimer _autosaveTimer;
    private readonly string _recoveryDirectory = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Frosty", "Recovery");
    private readonly ObservableCollection<TrackRow> _tracks = new();
    private readonly ObservableCollection<MediaAsset> _assets = new();
    private readonly ObservableCollection<ClipRow> _clips = new();
    private JsonObject? _maskModel;
    private string? _maskEditingClipId;
    private int _selectedMaskNode = -1;
    private int _selectedMaskSegment = 0;
    private double _selectedMaskSegmentT = 0.5;
    private int _maskDragNode = -1;
    private string? _maskDragRole;
    private Point _lastMaskPointer;
    private bool _maskEditorLoading;
    private const double TimelineLabelWidth = 128;
    private const double TimelineRulerHeight = 28;
    private const double TimelineTrackHeight = 56;
    private double _timelinePixelsPerSecond = 48;
    private double _timelinePlayheadSeconds;
    private bool _timelineScrubbing;
    private string? _timelineSelectionAnchorId;
    private bool _syncingTimelineSelection;
    private readonly HashSet<string> _selectedTimelineClipIds = new(StringComparer.Ordinal);
    private Dictionary<string, TimelineEditState>? _timelinePreviewStates;
    private TimelineDragState? _timelineDrag;
    private readonly record struct TimelineEditState(double Start, double SourceIn, double SourceOut, string TrackId);
    private enum TimelineDragMode { Move, TrimLeft, TrimRight }
    private sealed class TimelineDragState
    {
        public string PrimaryId { get; init; } = "";
        public TimelineDragMode Mode { get; init; }
        public Point StartPointer { get; init; }
        public Dictionary<string, TimelineEditState> Original { get; init; } = new(StringComparer.Ordinal);
        public string OriginalTrackId { get; init; } = "";
    }
    private readonly record struct MaskHandleRef(int Node, string Role);

    public MainWindow() : this(false) { }

    // The smoke-test constructor skips recovery prompts so Windows CI can verify native
    // DLL loading and the actual WPF window lifecycle in a clean, unattended session.
    public MainWindow(bool smokeTest)
    {
        InitializeComponent();
        GpuPreviewSurface.StatusChanged += GpuPreviewSurface_StatusChanged;
        TimelineTracks.ItemsSource = _tracks;
        MediaAssets.ItemsSource = _assets;
        TimelineClips.ItemsSource = _clips;
        _autosaveTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(60) };
        _autosaveTimer.Tick += (_, _) => CreateRecoverySnapshot();
        _autosaveTimer.Start();
        NewProject();
        if (smokeTest && _project == IntPtr.Zero) throw new InvalidOperationException("Native C++ engine failed to initialize during Windows smoke test.");
        if (!smokeTest) TryOfferRecovery();
    }

    private sealed class TrackRow
    {
        public string Id { get; init; } = ""; public string Name { get; init; } = ""; public string Type { get; init; } = "";
        public int Order { get; init; } public string State { get; init; } = ""; public int ClipCount { get; init; }
        public bool Locked { get; init; } public bool Muted { get; init; } public bool Visible { get; init; }
    }
    private sealed class MediaAsset
    {
        public string Id { get; init; } = ""; public string Path { get; init; } = ""; public string Name { get; init; } = "";
        public string MediaType { get; init; } = "video"; public double Duration { get; init; } public bool Missing { get; init; }
        public override string ToString() => Name;
    }
    private sealed class ClipRow
    {
        public string Id { get; init; } = ""; public string AssetId { get; init; } = ""; public string Name { get; init; } = "";
        public string TrackId { get; init; } = ""; public string TrackName { get; init; } = ""; public string MediaType { get; init; } = "video";
        public string SourcePath { get; init; } = ""; public double TimelineStart { get; init; } public double SourceIn { get; init; }
        public double SourceOut { get; init; } public double Duration { get; init; } public double PlaybackRate { get; init; } public double Opacity { get; init; } public double Volume { get; init; } = 1; public bool Enabled { get; init; } = true;
        public double TransformX { get; init; } public double TransformY { get; init; } public double ScaleX { get; init; } = 1; public double ScaleY { get; init; } = 1; public double Rotation { get; init; } public double ShearX { get; init; } public double ShearY { get; init; }
    }

    private static class Native
    {
        private const string Dll = "frosty_core.dll";
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr frosty_project_create();
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode, EntryPoint = "frosty_project_load_w")] internal static extern IntPtr frosty_project_load(string path, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode, EntryPoint = "frosty_project_save_w")] internal static extern int frosty_project_save(IntPtr project, string path, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr frosty_project_summary(IntPtr project);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern IntPtr frosty_project_json(IntPtr project);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode, EntryPoint = "frosty_project_add_asset_w")] internal static extern int frosty_project_add_asset(IntPtr project, string path, [MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.LPStr)] string mediaType, double duration, [MarshalAs(UnmanagedType.LPStr)] StringBuilder assetId, int assetIdCapacity, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int errorCapacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_add_track(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.LPStr)] string type, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_set_track_state(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string trackId, [MarshalAs(UnmanagedType.LPStr)] string property, int value, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_add_clip(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string trackId, [MarshalAs(UnmanagedType.LPStr)] string assetId, [MarshalAs(UnmanagedType.LPStr)] string name, double start, double inTime, double outTime, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_move_clip(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string clipId, double start, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_apply_clip_edits_json(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string editsJson, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_timeline_edit(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string operation, double start, double end, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_set_clip_range(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string clipId, double inTime, double outTime, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_remove_clip(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string clipId, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_set_clip_volume(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string clipId, double volume, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_set_clip_mask_json(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string clipId, [MarshalAs(UnmanagedType.LPStr)] string maskJson, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_set_clip_effect(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string clipId, [MarshalAs(UnmanagedType.LPStr)] string effectType, [MarshalAs(UnmanagedType.LPStr)] string parameterName, double value, int enabled, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern int frosty_project_set_clip_keyframe(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string clipId, [MarshalAs(UnmanagedType.LPStr)] string propertyName, double time, double value, [MarshalAs(UnmanagedType.LPStr)] string interpolation, [MarshalAs(UnmanagedType.LPStr)] StringBuilder error, int capacity);
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] internal static extern double frosty_project_evaluate_keyframe(IntPtr project, [MarshalAs(UnmanagedType.LPStr)] string clipId, [MarshalAs(UnmanagedType.LPStr)] string propertyName, double time, double defaultValue);
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
        StopPreview();
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
        try { using var doc = JsonDocument.Parse(PtrString(Native.frosty_project_validation(_project))); var valid = doc.RootElement.GetProperty("valid").GetBoolean(); if (!valid) StatusText.Text = "Validation issues detected; inspect the project before exporting."; else if (!_dirty) StatusText.Text = "Project valid"; }
        catch { StatusText.Text = "Project loaded; validation status unavailable"; }
        Title = $"Frosty{(_dirty ? " *" : "")} — Native editor";
    }
    private void RefreshTimeline()
    {
        if (_project == IntPtr.Zero || _refreshing) return;
        _refreshing = true;
        try
        {
            var selectedAssetId = (MediaAssets.SelectedItem as MediaAsset)?.Id;
            var selectedClipId = (TimelineClips.SelectedItem as ClipRow)?.Id;
            var selectedTrackId = (TimelineTracks.SelectedItem as TrackRow)?.Id;
            _tracks.Clear(); _assets.Clear(); _clips.Clear();
            using var doc = JsonDocument.Parse(PtrString(Native.frosty_project_json(_project)));
            var root = doc.RootElement;
            if (root.TryGetProperty("settings", out var projectSettings))
            {
                ResolutionText.Text = $"{GetInt(projectSettings, "width")} × {GetInt(projectSettings, "height")}";
                if (projectSettings.TryGetProperty("frameRate", out var fps)) FrameRateText.Text = $"{GetInt(fps, "numerator")} / {GetInt(fps, "denominator")} fps";
                ColorSpaceText.Text = $"{GetString(projectSettings, "colorSpace").ToUpperInvariant()} · {GetString(projectSettings, "colorRange")}";
            }
            var assetById = new Dictionary<string, MediaAsset>();
            if (root.TryGetProperty("assets", out var assets)) foreach (var asset in assets.EnumerateArray())
            {
                var row = new MediaAsset { Id = GetString(asset, "id"), Path = GetString(asset, "path"), Name = GetString(asset, "name"), MediaType = GetString(asset, "mediaType", "video"), Duration = GetDouble(asset, "duration"), Missing = GetBool(asset, "missing") || !System.IO.File.Exists(GetString(asset, "path")) };
                _assets.Add(row); assetById[row.Id] = row;
            }
            if (!root.TryGetProperty("sequences", out var sequences)) return;
            var activeId = GetString(root, "activeSequenceId");
            var chosen = sequences.EnumerateArray().FirstOrDefault(s => GetString(s, "id") == activeId);
            if (chosen.ValueKind == JsonValueKind.Undefined) chosen = sequences.EnumerateArray().FirstOrDefault();
            if (chosen.ValueKind != JsonValueKind.Object) return;
            var trackNames = new Dictionary<string, string>();
            var clipCounts = new Dictionary<string, int>();
            if (chosen.TryGetProperty("clips", out var clips)) foreach (var clip in clips.EnumerateArray()) { var id = GetString(clip, "trackId"); if (id.Length > 0) clipCounts[id] = clipCounts.GetValueOrDefault(id) + 1; }
            if (chosen.TryGetProperty("tracks", out var tracks)) foreach (var track in tracks.EnumerateArray())
            {
                var id = GetString(track, "id"); var name = GetString(track, "name"); trackNames[id] = name;
                var muted = GetBool(track, "muted"); var solo = GetBool(track, "solo"); var locked = GetBool(track, "locked"); var visible = GetBool(track, "visible", true);
                var state = string.Join(" · ", new[] { muted ? "Muted" : "", solo ? "Solo" : "", locked ? "Locked" : "", !visible ? "Hidden" : "" }.Where(x => x.Length > 0));
                _tracks.Add(new TrackRow { Id = id, Name = name, Type = GetString(track, "type"), Order = GetInt(track, "order"), State = state.Length == 0 ? "Normal" : state, ClipCount = clipCounts.GetValueOrDefault(id), Locked = locked, Muted = muted, Visible = visible });
            }
            if (chosen.TryGetProperty("clips", out clips)) foreach (var clip in clips.EnumerateArray())
            {
                var assetId = GetString(clip, "assetId"); assetById.TryGetValue(assetId, out var asset);
                var sourceIn = GetDouble(clip, "sourceIn"); var sourceOut = GetDouble(clip, "sourceOut"); var rate = Math.Max(0.001, GetDouble(clip, "playbackRate", 1));
                var trackId = GetString(clip, "trackId");
                _clips.Add(new ClipRow { Id = GetString(clip, "id"), AssetId = assetId, Name = GetString(clip, "name"), TrackId = trackId, TrackName = trackNames.GetValueOrDefault(trackId, "?"), MediaType = GetString(clip, "mediaType", asset?.MediaType ?? "video"), SourcePath = asset?.Path ?? "", TimelineStart = GetDouble(clip, "timelineStart"), SourceIn = sourceIn, SourceOut = sourceOut, Duration = Math.Max(0, sourceOut - sourceIn) / rate, PlaybackRate = rate, Opacity = GetDouble(clip, "opacity", 1), Volume = GetDouble(clip, "volume", 1), Enabled = GetBool(clip, "enabled", true), TransformX = GetTransformNumber(clip, "x", 0), TransformY = GetTransformNumber(clip, "y", 0), ScaleX = GetTransformNumber(clip, "scaleX", 1), ScaleY = GetTransformNumber(clip, "scaleY", 1), Rotation = GetTransformNumber(clip, "rotation", 0), ShearX = GetTransformNumber(clip, "shearX", 0), ShearY = GetTransformNumber(clip, "shearY", 0) });
            }
            if (selectedAssetId is not null) MediaAssets.SelectedItem = _assets.FirstOrDefault(a => a.Id == selectedAssetId);
            if (selectedClipId is not null) TimelineClips.SelectedItem = _clips.FirstOrDefault(c => c.Id == selectedClipId);
            if (selectedTrackId is not null) TimelineTracks.SelectedItem = _tracks.FirstOrDefault(t => t.Id == selectedTrackId);
        }
        catch (Exception ex) { StatusText.Text = "Could not render native project model: " + ex.Message; }
        finally { _refreshing = false; }
        _selectedTimelineClipIds.RemoveWhere(id => !_clips.Any(c => c.Id == id));
        if (TimelineClips.SelectedItem is ClipRow nowSelected) _selectedTimelineClipIds.Add(nowSelected.Id);
        if (TimelineClips.SelectedItem is ClipRow refreshedSelection) SetTimelineSelection(refreshedSelection.Id);
        else SetTimelineSelection(null);
    }
    private static double GetTransformNumber(JsonElement clip, string property, double fallback)
    {
        if (clip.TryGetProperty("legacyFields", out var legacy) && legacy.ValueKind == JsonValueKind.Object)
        {
            if (legacy.TryGetProperty("transform", out var transform) && transform.ValueKind == JsonValueKind.Object && transform.TryGetProperty(property, out var value) && value.TryGetDouble(out var number) && double.IsFinite(number)) return number;
            if (legacy.TryGetProperty(property, out var direct) && direct.TryGetDouble(out var directNumber) && double.IsFinite(directNumber)) return directNumber;
        }
        return fallback;
    }
    private double MaskTime => double.TryParse(MaskPathTimeText.Text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var value) && double.IsFinite(value) ? Math.Max(0, value) : 0;
    private string MaskInterpolation => (MaskInterpolationCombo.SelectedItem as ComboBoxItem)?.Content?.ToString() is { } value ? BezierMaskModel.ValidInterpolation(value) : "linear";

    private void RefreshMaskEditorForSelectedClip()
    {
        if (BezierMaskCanvas is null || _maskEditorLoading) return;
        _maskEditorLoading = true;
        try
        {
            var clip = TimelineClips.SelectedItem as ClipRow;
            _maskEditingClipId = clip?.Id; _selectedMaskNode = -1; _selectedMaskSegment = 0;
            _maskModel = null;
            if (clip is not null && _project != IntPtr.Zero)
            {
                using var doc = JsonDocument.Parse(PtrString(Native.frosty_project_json(_project)));
                var root = doc.RootElement;
                var seqId = GetString(root, "activeSequenceId");
                var seq = root.GetProperty("sequences").EnumerateArray().FirstOrDefault(v => GetString(v, "id") == seqId);
                if (seq.ValueKind == JsonValueKind.Object && seq.TryGetProperty("clips", out var clips))
                {
                    var nativeClip = clips.EnumerateArray().FirstOrDefault(v => GetString(v, "id") == clip.Id);
                    if (nativeClip.ValueKind == JsonValueKind.Object && nativeClip.TryGetProperty("legacyFields", out var legacy) && legacy.ValueKind == JsonValueKind.Object && legacy.TryGetProperty("mask", out var mask)) _maskModel = BezierMaskModel.FromElement(mask);
                }
            }
            var hasClip = clip is not null;
            MaskEnabledCheck.IsEnabled = hasClip;
            if (_maskModel is not null && StringMask(_maskModel["shape"]) != "bezier") _maskModel = null;
            MaskEnabledCheck.IsChecked = _maskModel is not null && IsMaskEnabled(_maskModel);
            var available = hasClip && _maskModel is not null && IsMaskEnabled(_maskModel);
            MaskAddAnchorButton.IsEnabled = available; MaskRemoveAnchorButton.IsEnabled = available; MaskAddKeyframeButton.IsEnabled = available; MaskClearKeyframesButton.IsEnabled = available;
            MaskFeatherText.IsEnabled = available; MaskInvertCheck.IsEnabled = available; MaskPathTimeText.IsEnabled = available; MaskInterpolationCombo.IsEnabled = available;
            MaskFeatherText.Text = _maskModel is null ? "0" : MaskNumber(_maskModel["feather"]).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
            MaskInvertCheck.IsChecked = _maskModel is not null && MaskBool(_maskModel["invert"]);
            var keyCount = (_maskModel?["pathKeyframes"] as JsonArray)?.Count ?? 0;
            MaskDeleteKeyframeButton.IsEnabled = available && keyCount > 0;
            MaskStatus.Text = !hasClip ? "Select a clip before editing its mask." : _maskModel is null ? "No Bézier mask on this clip. Enable the mask to create an editable vector path." : available ? $"{BezierMaskModel.ReadNodes(_maskModel["nodes"]).Count} anchors · {keyCount} path keyframe(s) · feather {MaskNumber(_maskModel["feather"]):0.##}" : "Bézier mask disabled. Enable it to edit or animate the path.";
            RenderBezierMaskEditor();
        }
        catch (Exception ex) { MaskStatus.Text = "Could not load mask: " + ex.Message; }
        finally { _maskEditorLoading = false; }
    }
    private static double MaskNumber(JsonNode? node) => double.TryParse(node?.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var value) && double.IsFinite(value) ? value : 0;
    private static bool MaskBool(JsonNode? node) => bool.TryParse(node?.ToString(), out var value) && value;
    private static bool IsMaskEnabled(JsonObject mask) => !bool.TryParse(mask["enabled"]?.ToString(), out var value) || value;
    private void EnsureMaskModel()
    {
        if (_maskModel is null || BezierMaskModel.ReadNodes(_maskModel["nodes"]).Count < 3) _maskModel = BezierMaskModel.DefaultMask();
        _maskModel["shape"] = "bezier"; _maskModel["enabled"] = true;
        _maskModel["pathKeyframes"] ??= new JsonArray();
    }
    private void SaveMaskModel(string status = "Bézier mask saved to the native project.")
    {
        if (_maskModel is null || string.IsNullOrWhiteSpace(_maskEditingClipId) || _project == IntPtr.Zero) return;
        var error = new StringBuilder(2048);
        var result = Native.frosty_project_set_clip_mask_json(_project, _maskEditingClipId, _maskModel.ToJsonString(), error, error.Capacity);
        if (result == 0) { MessageBox.Show(this, error.ToString(), "Mask update rejected", MessageBoxButton.OK, MessageBoxImage.Warning); RefreshMaskEditorForSelectedClip(); return; }
        _dirty = true; UpdateSummary(); StatusText.Text = status; MaskStatus.Text = status;
    }
    private List<BezierMaskModel.Node> EditableNodesAtTime()
    {
        EnsureMaskModel(); return BezierMaskModel.Evaluate(_maskModel!, MaskTime);
    }
    private void RefreshMaskInterpolationSelection()
    {
        if (MaskInterpolationCombo is null) return; // XAML can raise TextChanged before every named control has been constructed.
        var interpolation = "linear";
        if (_maskModel?["pathKeyframes"] is JsonArray keys && keys.Count > 0)
        {
            var ordered = keys.OfType<JsonObject>().OrderBy(k => MaskNumber(k["t"])).ToList();
            var current = ordered.LastOrDefault(k => MaskNumber(k["t"]) <= MaskTime + 1e-5) ?? ordered.FirstOrDefault();
            if (current is not null) interpolation = BezierMaskModel.ValidInterpolation(current["interpolation"]?.ToString() ?? "linear");
        }
        var item = MaskInterpolationCombo.Items.OfType<ComboBoxItem>().FirstOrDefault(i => string.Equals(i.Content?.ToString(), interpolation, StringComparison.Ordinal));
        if (item is not null) MaskInterpolationCombo.SelectedItem = item;
    }
    private void RenderBezierMaskEditor()
    {
        if (BezierMaskCanvas is null) return;
        RefreshMaskInterpolationSelection();
        BezierMaskCanvas.Children.Clear();
        var mask = _maskModel;
        if (mask is null || !IsMaskEnabled(mask) || StringMask(mask["shape"]) != "bezier")
        { BezierMaskCanvas.Children.Add(new TextBlock { Text = "Enable Bézier mask", Foreground = Brushes.Gray, FontSize = 12, Margin = new Thickness(10,54,0,0), IsHitTestVisible = false }); return; }
        var nodes = BezierMaskModel.Evaluate(mask, MaskTime);
        var width = Math.Max(32, BezierMaskCanvas.ActualWidth > 32 ? BezierMaskCanvas.ActualWidth : BezierMaskCanvas.Width);
        var height = Math.Max(32, BezierMaskCanvas.ActualHeight > 32 ? BezierMaskCanvas.ActualHeight : BezierMaskCanvas.Height);
        Point Pixel(BezierMaskModel.Point p) => new(p.X*width,p.Y*height);
        var figure = new PathFigure { StartPoint = Pixel(new BezierMaskModel.Point(nodes[0].X,nodes[0].Y)), IsClosed = true, IsFilled = true };
        for (var i=0;i<nodes.Count;i++) { var a=nodes[i]; var b=nodes[(i+1)%nodes.Count]; figure.Segments.Add(new BezierSegment(Pixel(a.Out),Pixel(b.In),Pixel(new BezierMaskModel.Point(b.X,b.Y)),true)); }
        var geometry = new PathGeometry(); geometry.Figures.Add(figure);
        var path = new System.Windows.Shapes.Path { Data=geometry, Fill=new SolidColorBrush(Color.FromArgb(42,81,151,255)), Stroke=new SolidColorBrush(Color.FromRgb(91,169,255)), StrokeThickness=1.5, Tag="mask-path" };
        BezierMaskCanvas.Children.Add(path);
        for (var i=0;i<nodes.Count;i++)
        {
            var n=nodes[i]; var anchor=Pixel(new BezierMaskModel.Point(n.X,n.Y)); var pin=Pixel(n.In); var pout=Pixel(n.Out);
            AddMaskLine(anchor,pin); AddMaskLine(anchor,pout);
            AddMaskHandle(pin,new MaskHandleRef(i,"in"),7,new SolidColorBrush(Color.FromRgb(74,208,196)));
            AddMaskHandle(pout,new MaskHandleRef(i,"out"),7,new SolidColorBrush(Color.FromRgb(74,208,196)));
            AddMaskHandle(anchor,new MaskHandleRef(i,"anchor"),10,new SolidColorBrush(i==_selectedMaskNode?Color.FromRgb(255,208,92):Color.FromRgb(255,255,255)));
        }
        void AddMaskLine(Point a,Point b){var line=new Line{X1=a.X,Y1=a.Y,X2=b.X,Y2=b.Y,Stroke=new SolidColorBrush(Color.FromArgb(150,116,147,181)),StrokeThickness=1,IsHitTestVisible=false};BezierMaskCanvas.Children.Add(line);}
        void AddMaskHandle(Point p,MaskHandleRef tag,double size,Brush fill){var dot=new Ellipse{Width=size,Height=size,Fill=fill,Stroke=new SolidColorBrush(Color.FromRgb(14,20,30)),StrokeThickness=1,Tag=tag,Cursor=Cursors.SizeAll};Canvas.SetLeft(dot,p.X-size/2);Canvas.SetTop(dot,p.Y-size/2);BezierMaskCanvas.Children.Add(dot);}
    }
    private static string StringMask(JsonNode? node) => node?.ToString() ?? "";
    private int ClosestMaskSegment(Point p, List<BezierMaskModel.Node> nodes, double width, double height, out double curveT)
    {
        const int samplesPerCurve=16;var bestIndex=0;var best=double.PositiveInfinity;var bestT=.5;var samples=BezierMaskModel.Sample(nodes,samplesPerCurve);
        for(var i=0;i<samples.Count;i++){var a=new Point(samples[i].X*width,samples[i].Y*height);var b=new Point(samples[(i+1)%samples.Count].X*width,samples[(i+1)%samples.Count].Y*height);var dx=b.X-a.X;var dy=b.Y-a.Y;var den=dx*dx+dy*dy;var segmentT=den<1e-9?0:Math.Clamp(((p.X-a.X)*dx+(p.Y-a.Y)*dy)/den,0,1);var q=new Point(a.X+segmentT*dx,a.Y+segmentT*dy);var d=(q-p).LengthSquared;if(d<best){best=d;bestIndex=(i/samplesPerCurve)%nodes.Count;bestT=Math.Clamp(((i%samplesPerCurve)+segmentT)/samplesPerCurve,.001,.999);}}
        curveT=bestT;return bestIndex;
    }
    private void BezierMaskCanvas_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (_maskModel is null || !IsMaskEnabled(_maskModel)) return;
        if (TimelineClips.SelectedItem is ClipRow selected && MaskTime > selected.Duration + 1e-6) { MaskStatus.Text = "Path edit time is beyond the selected clip duration."; return; }
        var p=e.GetPosition(BezierMaskCanvas);var width=Math.Max(32,BezierMaskCanvas.ActualWidth);var height=Math.Max(32,BezierMaskCanvas.ActualHeight);
        if (e.OriginalSource is FrameworkElement element && element.Tag is MaskHandleRef hit)
        { _maskDragNode=hit.Node;_maskDragRole=hit.Role;_selectedMaskNode=hit.Node;_lastMaskPointer=p;BezierMaskCanvas.CaptureMouse();e.Handled=true;RenderBezierMaskEditor();return; }
        var nodes=BezierMaskModel.Evaluate(_maskModel,MaskTime);_selectedMaskSegment=ClosestMaskSegment(p,nodes,width,height,out _selectedMaskSegmentT);
        if(e.ClickCount>=2){if(nodes.Count>=BezierMaskModel.MaxAnchors){MaskStatus.Text="A Bézier mask supports at most 12 anchors.";e.Handled=true;return;}BezierMaskModel.SplitSegmentEverywhere(_maskModel,_selectedMaskSegment,_selectedMaskSegmentT);_selectedMaskNode=_selectedMaskSegment+1;SaveMaskModel("Inserted Bézier anchor with curve-preserving subdivision.");RenderBezierMaskEditor();e.Handled=true;return;}
        RenderBezierMaskEditor();
    }
    private void BezierMaskCanvas_MouseMove(object sender, MouseEventArgs e)
    {
        if(_maskDragNode<0||_maskDragRole is null||_maskModel is null||e.LeftButton!=MouseButtonState.Pressed)return;
        var p=e.GetPosition(BezierMaskCanvas);var width=Math.Max(32,BezierMaskCanvas.ActualWidth);var height=Math.Max(32,BezierMaskCanvas.ActualHeight);
        var dx=(p.X-_lastMaskPointer.X)/width;var dy=(p.Y-_lastMaskPointer.Y)/height;_lastMaskPointer=p;
        var nodes=EditableNodesAtTime();if(_maskDragNode>=nodes.Count)return;var n=nodes[_maskDragNode];
        if(_maskDragRole=="anchor")nodes[_maskDragNode]=n with { X=Math.Clamp(n.X+dx,0,1),Y=Math.Clamp(n.Y+dy,0,1),In=new BezierMaskModel.Point(Math.Clamp(n.In.X+dx,0,1),Math.Clamp(n.In.Y+dy,0,1)),Out=new BezierMaskModel.Point(Math.Clamp(n.Out.X+dx,0,1),Math.Clamp(n.Out.Y+dy,0,1)) };
        else if(_maskDragRole=="in") {var ix=Math.Clamp(n.In.X+dx,0,1);var iy=Math.Clamp(n.In.Y+dy,0,1);var opposite=Keyboard.IsKeyDown(Key.LeftShift)||Keyboard.IsKeyDown(Key.RightShift);var ox=opposite?Math.Clamp(2*n.X-ix,0,1):n.Out.X;var oy=opposite?Math.Clamp(2*n.Y-iy,0,1):n.Out.Y;nodes[_maskDragNode]=n with { In=new BezierMaskModel.Point(ix,iy),Out=new BezierMaskModel.Point(ox,oy) };}
        else {var ox=Math.Clamp(n.Out.X+dx,0,1);var oy=Math.Clamp(n.Out.Y+dy,0,1);var opposite=Keyboard.IsKeyDown(Key.LeftShift)||Keyboard.IsKeyDown(Key.RightShift);var ix=opposite?Math.Clamp(2*n.X-ox,0,1):n.In.X;var iy=opposite?Math.Clamp(2*n.Y-oy,0,1):n.In.Y;nodes[_maskDragNode]=n with { Out=new BezierMaskModel.Point(ox,oy),In=new BezierMaskModel.Point(ix,iy) };}
        BezierMaskModel.SetAtTime(_maskModel,nodes,MaskTime,MaskInterpolation);RenderBezierMaskEditor();
    }
    private void BezierMaskCanvas_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    { if(_maskDragNode>=0){_maskDragNode=-1;_maskDragRole=null;BezierMaskCanvas.ReleaseMouseCapture();SaveMaskModel("Bézier anchor or handle updated.");RenderBezierMaskEditor();} }
    private void BezierMaskCanvas_SizeChanged(object sender, SizeChangedEventArgs e) { if(!_maskEditorLoading)RenderBezierMaskEditor(); }
    private void MaskEnabled_Changed(object sender, RoutedEventArgs e)
    {
        if(_maskEditorLoading||TimelineClips.SelectedItem is not ClipRow) return;
        if(MaskEnabledCheck.IsChecked==true){EnsureMaskModel();_maskModel!["enabled"]=true;}
        else if(_maskModel is not null)_maskModel["enabled"]=false;
        if(_maskModel is null){RefreshMaskEditorForSelectedClip();return;}
        SaveMaskModel(MaskEnabledCheck.IsChecked==true?"Bézier mask enabled.":"Bézier mask disabled.");
    }
    private void MaskAddAnchor_Click(object sender,RoutedEventArgs e)
    { if(_maskModel is null)return;var nodes=BezierMaskModel.ReadNodes(_maskModel["nodes"]);if(nodes.Count>=BezierMaskModel.MaxAnchors){MaskStatus.Text="A Bézier mask supports at most 12 anchors.";return;}BezierMaskModel.SplitSegmentEverywhere(_maskModel,Math.Clamp(_selectedMaskSegment,0,nodes.Count-1),_selectedMaskSegmentT);_selectedMaskNode=Math.Clamp(_selectedMaskSegment+1,0,nodes.Count);SaveMaskModel("Inserted Bézier anchor using de Casteljau subdivision.");RenderBezierMaskEditor(); }
    private void MaskRemoveAnchor_Click(object sender,RoutedEventArgs e)
    { if(_maskModel is null)return;var nodes=BezierMaskModel.ReadNodes(_maskModel["nodes"]);if(nodes.Count<=3){MaskStatus.Text="A closed Bézier path needs at least three anchors.";return;}var index=_selectedMaskNode>=0?_selectedMaskNode:0;if(BezierMaskModel.RemoveAnchorEverywhere(_maskModel,index)){_selectedMaskNode=-1;SaveMaskModel("Anchor removed from the base path and all keyframes.");RenderBezierMaskEditor();} }
    private void MaskAddKeyframe_Click(object sender,RoutedEventArgs e)
    { if(_maskModel is null)return;if(TimelineClips.SelectedItem is ClipRow selected&&MaskTime>selected.Duration+1e-6){MaskStatus.Text="A path keyframe must fall within the selected clip duration.";return;}var nodes=BezierMaskModel.Evaluate(_maskModel,MaskTime);var keys=_maskModel["pathKeyframes"] as JsonArray;if(keys is null){keys=new JsonArray();_maskModel["pathKeyframes"]=keys;}var t=MaskTime;var existing=keys.OfType<JsonObject>().FirstOrDefault(k=>Math.Abs(MaskNumber(k["t"])-t)<1e-5);if(existing is null)keys.Add(new JsonObject{["t"]=t,["interpolation"]=MaskInterpolation,["nodes"]=BezierMaskModel.ToJsonArray(nodes)});else{existing["nodes"]=BezierMaskModel.ToJsonArray(nodes);existing["interpolation"]=MaskInterpolation;}var ordered=keys.OfType<JsonObject>().OrderBy(k=>MaskNumber(k["t"])).Select(k=>(JsonNode)k.DeepClone()).ToList();keys.Clear();foreach(var k in ordered)keys.Add(k);SaveMaskModel($"Path keyframe saved at {t:0.###}s.");RenderBezierMaskEditor(); }
    private void MaskDeleteKeyframe_Click(object sender,RoutedEventArgs e)
    {
        if(_maskModel is null||_maskModel["pathKeyframes"] is not JsonArray keys)return;
        var key=keys.OfType<JsonObject>().FirstOrDefault(k=>Math.Abs(MaskNumber(k["t"])-MaskTime)<1e-5);
        if(key is null){MaskStatus.Text=$"No path keyframe exists at {MaskTime:0.###}s.";return;}
        var retainedNodes=BezierMaskModel.ReadNodes(key["nodes"]);keys.Remove(key);
        if(keys.Count==0)_maskModel["nodes"]=BezierMaskModel.ToJsonArray(retainedNodes);
        SaveMaskModel($"Path keyframe at {MaskTime:0.###}s deleted.");RenderBezierMaskEditor();
    }
    private void MaskClearKeyframes_Click(object sender,RoutedEventArgs e)
    { if(_maskModel is null)return;var nodes=BezierMaskModel.Evaluate(_maskModel,MaskTime);_maskModel["nodes"]=BezierMaskModel.ToJsonArray(nodes);_maskModel["pathKeyframes"]=new JsonArray();SaveMaskModel("Path animation cleared; the current pose is now the static mask.");RenderBezierMaskEditor(); }
    private void MaskFeather_LostFocus(object sender,RoutedEventArgs e)
    { if(_maskEditorLoading||_maskModel is null)return;if(!double.TryParse(MaskFeatherText.Text,System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out var feather)||!double.IsFinite(feather)){MaskFeatherText.Text=MaskNumber(_maskModel["feather"]).ToString(CultureInfo.InvariantCulture);return;}_maskModel["feather"]=Math.Clamp(feather,0,100);SaveMaskModel("Mask feather updated."); }
    private void MaskPathTimeText_Changed(object sender,TextChangedEventArgs e) { if(!_maskEditorLoading)RenderBezierMaskEditor(); }
    private void MaskInvert_Changed(object sender,RoutedEventArgs e)
    { if(_maskEditorLoading||_maskModel is null)return;_maskModel["invert"]=MaskInvertCheck.IsChecked==true;SaveMaskModel("Mask inversion updated."); }

    private static string GetString(JsonElement e, string key, string fallback = "") => e.TryGetProperty(key, out var v) && v.ValueKind != JsonValueKind.Null ? v.ToString() : fallback;
    private static int GetInt(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.TryGetInt32(out var n) ? n : 0;
    private static double GetDouble(JsonElement e, string key, double fallback = 0) => e.TryGetProperty(key, out var v) && v.TryGetDouble(out var n) && double.IsFinite(n) ? n : fallback;
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
        _currentPath = path; _dirty = false; UpdateSummary(); StatusText.Text = "Saved atomically: " + path; return true;
    }
    private void SaveProject_Click(object sender, RoutedEventArgs e) { if (_currentPath is null) SaveAs_Click(sender, e); else SaveTo(_currentPath); }
    private void SaveAs_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new SaveFileDialog { Filter = "Frosty project (*.frosty)|*.frosty", DefaultExt = ".frosty", FileName = "Untitled.frosty" };
        if (dialog.ShowDialog(this) == true) SaveTo(dialog.FileName);
    }
    private void ImportMedia_Click(object sender, RoutedEventArgs e)
    {
        if (_project == IntPtr.Zero) { StatusText.Text = "Create or open a project first."; return; }
        var dialog = new OpenFileDialog { Title = "Import media into Frosty", Filter = "Media files|*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4v;*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg;*.opus;*.wma;*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif;*.tif;*.tiff|All files|*.*", Multiselect = true, CheckFileExists = true };
        if (dialog.ShowDialog(this) != true) return;
        int imported = 0; var problems = new List<string>();
        foreach (var file in dialog.FileNames)
        {
            var type = ClassifyMediaType(file); var duration = type == "image" ? 0 : ProbeDuration(file);
            var id = new StringBuilder(256); var error = new StringBuilder(2048);
            if (Native.frosty_project_add_asset(_project, file, System.IO.Path.GetFileName(file), type, duration, id, id.Capacity, error, error.Capacity) == 0) problems.Add(System.IO.Path.GetFileName(file) + ": " + error);
            else imported++;
        }
        if (imported > 0) { MarkDirty(); RefreshTimeline(); }
        if (problems.Count > 0) MessageBox.Show(this, string.Join(Environment.NewLine, problems), "Some media could not be imported", MessageBoxButton.OK, MessageBoxImage.Warning);
        StatusText.Text = $"Imported or referenced {imported} media file(s)." + (imported > 0 && _assets.Any(a => a.Duration <= 0 && a.MediaType != "image") ? " ffprobe was unavailable or duration could not be read for some files; those clips use a 5-second default." : "");
        if (MediaAssets.SelectedItem is not MediaAsset && _assets.Count > 0) MediaAssets.SelectedIndex = _assets.Count - 1;
    }
    private static string ClassifyMediaType(string file)
    {
        var ext = System.IO.Path.GetExtension(file).ToLowerInvariant();
        if (new[] { ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff" }.Contains(ext)) return "image";
        if (new[] { ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".aiff", ".alac" }.Contains(ext)) return "audio";
        return "video";
    }
    private static double ProbeDuration(string file)
    {
        if (MediaToolPaths.HasFfprobe)
        {
            try
            {
                var start = new ProcessStartInfo { FileName = MediaToolPaths.Ffprobe, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
                foreach (var arg in new[] { "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file }) start.ArgumentList.Add(arg);
                using var process = Process.Start(start); if (process is null) return 0;
                var outputTask = process.StandardOutput.ReadToEndAsync(); var errorTask = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(7000)) { try { process.Kill(true); } catch { } return 0; }
                var output = outputTask.GetAwaiter().GetResult(); _ = errorTask.GetAwaiter().GetResult();
                if (double.TryParse(output.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var value) && double.IsFinite(value) && value > 0) return value;
            }
            catch { /* Fall back to parsing FFmpeg input diagnostics. */ }
        }
        try
        {
            var start = new ProcessStartInfo { FileName = MediaToolPaths.Ffmpeg, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
            foreach (var arg in new[] { "-hide_banner", "-i", file, "-t", "0.01", "-f", "null", "-" }) start.ArgumentList.Add(arg);
            using var process = Process.Start(start); if (process is null) return 0;
            var outputTask = process.StandardOutput.ReadToEndAsync(); var errorTask = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(7000)) { try { process.Kill(true); } catch { } return 0; }
            var diagnostic = errorTask.GetAwaiter().GetResult() + "\n" + outputTask.GetAwaiter().GetResult();
            var match = Regex.Match(diagnostic, @"Duration:\s*(\d{2,}):(\d{2}):(\d+(?:\.\d+)?)", RegexOptions.IgnoreCase);
            if (!match.Success) return 0;
            var duration = (double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture) * 3600) + (double.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture) * 60) + double.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
            return double.IsFinite(duration) && duration > 0 ? duration : 0;
        }
        catch { return 0; }
    }
    private void AddVideoTrack_Click(object sender, RoutedEventArgs e) => AddTrack("video");
    private void AddAudioTrack_Click(object sender, RoutedEventArgs e) => AddTrack("audio");
    private void AddTrack(string type)
    {
        if (_project == IntPtr.Zero) return;
        var error = new StringBuilder(2048); var name = type == "audio" ? $"A{_tracks.Count(x => x.Type == "audio") + 1}" : $"V{_tracks.Count(x => x.Type == "video") + 1}";
        if (Native.frosty_project_add_track(_project, name, type, error, error.Capacity) == 0) { MessageBox.Show(this, error.ToString(), "Track operation failed", MessageBoxButton.OK, MessageBoxImage.Error); return; }
        MarkDirty(); RefreshTimeline(); StatusText.Text = $"Added {type} track {name}.";
    }
    private void AddSelectedClip_Click(object sender, RoutedEventArgs e)
    {
        if (MediaAssets.SelectedItem is not MediaAsset asset) { StatusText.Text = "Select media in the left panel first."; return; }
        if (asset.Missing || !System.IO.File.Exists(asset.Path)) { StatusText.Text = "The source file is missing; relink it before adding a clip."; return; }
        var compatible = _tracks.Where(t => asset.MediaType == "audio" ? t.Type == "audio" : t.Type == "video").ToList();
        var selectedTrack = TimelineTracks.SelectedItem as TrackRow;
        var track = selectedTrack is not null && compatible.Any(t => t.Id == selectedTrack.Id) ? selectedTrack : compatible.FirstOrDefault();
        if (track is null)
        {
            AddTrack(asset.MediaType == "audio" ? "audio" : "video");
            track = _tracks.FirstOrDefault(t => asset.MediaType == "audio" ? t.Type == "audio" : t.Type == "video");
        }
        if (track is null) { StatusText.Text = "Could not create a compatible track."; return; }
        var sourceOut = asset.Duration > 0 ? asset.Duration : 5.0;
        if (asset.MediaType == "image") sourceOut = 5.0;
        var start = _clips.Where(c => c.TrackId == track.Id).Select(c => c.TimelineStart + c.Duration).DefaultIfEmpty(0).Max();
        var error = new StringBuilder(2048);
        if (Native.frosty_project_add_clip(_project, track.Id, asset.Id, asset.Name, start, 0, sourceOut, error, error.Capacity) == 0)
        { MessageBox.Show(this, error.ToString(), "Clip placement failed", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
        MarkDirty(); RefreshTimeline(); StatusText.Text = $"Added {asset.Name} to {track.Name} at {start:0.00}s.";
        var added = _clips.Where(c => c.AssetId == asset.Id).OrderByDescending(c => c.TimelineStart).FirstOrDefault();
        if (added is not null) { _selectedTimelineClipIds.Clear(); _selectedTimelineClipIds.Add(added.Id); SetTimelineSelection(added.Id); }
    }
    private void ToggleLock_Click(object sender, RoutedEventArgs e) => ToggleSelectedTrackState("locked", row => !row.Locked);
    private void ToggleMute_Click(object sender, RoutedEventArgs e) => ToggleSelectedTrackState("muted", row => !row.Muted);
    private void ToggleSelectedTrackState(string property, Func<TrackRow, bool> next)
    {
        if (TimelineTracks.SelectedItem is not TrackRow row) { StatusText.Text = "Select a track first."; return; }
        var error = new StringBuilder(2048);
        if (Native.frosty_project_set_track_state(_project, row.Id, property, next(row) ? 1 : 0, error, error.Capacity) == 0) { MessageBox.Show(this, error.ToString(), "Track operation failed", MessageBoxButton.OK, MessageBoxImage.Error); return; }
        MarkDirty(); RefreshTimeline(); StatusText.Text = $"Updated {row.Name}.";
    }
    private TimelineEditState StateFor(ClipRow clip)
    {
        if (_timelinePreviewStates is not null && _timelinePreviewStates.TryGetValue(clip.Id, out var preview)) return preview;
        return new TimelineEditState(clip.TimelineStart, clip.SourceIn, clip.SourceOut, clip.TrackId);
    }
    private static void CanvasLine(Canvas canvas, double x1, double y1, double x2, double y2, Brush brush, double thickness = 1)
    {
        var line = new Line { X1 = x1, Y1 = y1, X2 = x2, Y2 = y2, Stroke = brush, StrokeThickness = thickness, IsHitTestVisible = false };
        canvas.Children.Add(line);
    }
    private static void CanvasLabel(Canvas canvas, string text, double left, double top, double width, Brush color, double size = 11, FontWeight? weight = null)
    {
        var label = new TextBlock { Text = text, Foreground = color, FontSize = size, FontWeight = weight ?? FontWeights.Normal, Width = width, TextTrimming = TextTrimming.CharacterEllipsis, IsHitTestVisible = false };
        Canvas.SetLeft(label, left); Canvas.SetTop(label, top); canvas.Children.Add(label);
    }
    private void RenderTimelineCanvas()
    {
        if (TimelineCanvas is null) return;
        TimelineCanvas.Children.Clear();
        var tracks = _tracks.OrderBy(t => t.Order).ToList();
        var end = _clips.Select(c => { var st = StateFor(c); return st.Start + Math.Max(0, st.SourceOut - st.SourceIn) / Math.Max(.001, c.PlaybackRate); }).DefaultIfEmpty(0).Max();
        var seconds = Math.Max(20, end + 8);
        var width = Math.Clamp(TimelineLabelWidth + seconds * _timelinePixelsPerSecond, 1200, 60000);
        var height = TimelineRulerHeight + Math.Max(1, tracks.Count) * TimelineTrackHeight;
        TimelineCanvas.Width = width; TimelineCanvas.Height = height;
        var bg = new Rectangle { Width = width, Height = height, Fill = new SolidColorBrush(Color.FromRgb(12, 16, 24)), IsHitTestVisible = false };
        TimelineCanvas.Children.Add(bg);
        var ruler = new Rectangle { Width = width, Height = TimelineRulerHeight, Fill = new SolidColorBrush(Color.FromRgb(23, 29, 42)), IsHitTestVisible = false };
        TimelineCanvas.Children.Add(ruler);
        CanvasLine(TimelineCanvas, TimelineLabelWidth, 0, TimelineLabelWidth, height, new SolidColorBrush(Color.FromRgb(55, 65, 84)), 1.5);
        var step = _timelinePixelsPerSecond < 28 ? 5 : 1;
        var maxSeconds = Math.Max(1, (int)Math.Ceiling((width - TimelineLabelWidth) / _timelinePixelsPerSecond));
        var trackY = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < tracks.Count; i++)
        {
            var track = tracks[i]; trackY[track.Id] = i;
            var y = TimelineRulerHeight + i * TimelineTrackHeight;
            var rowFill = new Rectangle { Width = width, Height = TimelineTrackHeight, Fill = new SolidColorBrush(i % 2 == 0 ? Color.FromRgb(17, 22, 33) : Color.FromRgb(14, 19, 29)), IsHitTestVisible = false };
            Canvas.SetLeft(rowFill, 0); Canvas.SetTop(rowFill, y); TimelineCanvas.Children.Add(rowFill);
            CanvasLine(TimelineCanvas, 0, y, width, y, new SolidColorBrush(Color.FromRgb(39, 47, 64)));
            var state = track.State == "Normal" ? track.Type.ToUpperInvariant() : track.State;
            CanvasLabel(TimelineCanvas, track.Name, 8, y + 10, TimelineLabelWidth - 15, new SolidColorBrush(track.Locked ? Color.FromRgb(215, 158, 100) : Color.FromRgb(225, 230, 241)), 11, FontWeights.SemiBold);
            CanvasLabel(TimelineCanvas, state, 8, y + 30, TimelineLabelWidth - 15, new SolidColorBrush(Color.FromRgb(129, 141, 164)), 9);
        }
        // Draw grid lines after opaque row backgrounds so the time grid remains visible.
        for (var sec = 0; sec <= maxSeconds; sec += step)
        {
            var x = TimelineLabelWidth + sec * _timelinePixelsPerSecond;
            CanvasLine(TimelineCanvas, x, TimelineRulerHeight, x, height, new SolidColorBrush(Color.FromArgb(sec % 5 == 0 ? (byte)65 : (byte)34, 110, 128, 150)));
            CanvasLine(TimelineCanvas, x, 0, x, TimelineRulerHeight, new SolidColorBrush(Color.FromArgb(sec % 5 == 0 ? (byte)120 : (byte)55, 145, 163, 190)));
            CanvasLabel(TimelineCanvas, sec + "s", x + 3, 6, 42, new SolidColorBrush(Color.FromRgb(193, 202, 218)), 10, FontWeights.SemiBold);
        }
        foreach (var clip in _clips)
        {
            var state = StateFor(clip);
            if (!trackY.TryGetValue(state.TrackId, out var rowIndex)) continue;
            var duration = Math.Max(.05, (state.SourceOut - state.SourceIn) / Math.Max(.001, clip.PlaybackRate));
            var x = TimelineLabelWidth + Math.Max(0, state.Start) * _timelinePixelsPerSecond;
            var y = TimelineRulerHeight + rowIndex * TimelineTrackHeight + 7;
            var w = Math.Max(12, duration * _timelinePixelsPerSecond);
            var selected = _selectedTimelineClipIds.Contains(clip.Id);
            var color = clip.MediaType == "audio" ? Color.FromRgb(94, 79, 164) : clip.MediaType == "image" ? Color.FromRgb(55, 135, 128) : Color.FromRgb(49, 105, 170);
            var border = new Border { Width = w, Height = TimelineTrackHeight - 14, CornerRadius = new CornerRadius(5), Background = new SolidColorBrush(color), Opacity = clip.Enabled ? 1.0 : 0.38, BorderBrush = selected ? new SolidColorBrush(Color.FromRgb(112, 200, 255)) : new SolidColorBrush(Color.FromRgb(91, 112, 148)), BorderThickness = selected ? new Thickness(2) : new Thickness(1), Tag = clip.Id, ToolTip = $"{clip.Name}\nEnabled: {clip.Enabled}\nTrack: {clip.TrackName}\nTimeline: {state.Start:0.00}–{state.Start + duration:0.00}s\nSource: {state.SourceIn:0.00}–{state.SourceOut:0.00}s\nDrag middle to move; drag edges to trim" };
            border.Child = new TextBlock { Text = clip.Name, Foreground = Brushes.White, FontSize = 10, FontWeight = FontWeights.SemiBold, Margin = new Thickness(8, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis, IsHitTestVisible = false };
            Canvas.SetLeft(border, x); Canvas.SetTop(border, y); TimelineCanvas.Children.Add(border);
            if (w > 52)
            {
                CanvasLine(TimelineCanvas, x + 5, y + 3, x + 5, y + TimelineTrackHeight - 17, selected ? Brushes.White : new SolidColorBrush(Color.FromArgb(160, 225, 235, 255)), 2);
                CanvasLine(TimelineCanvas, x + w - 5, y + 3, x + w - 5, y + TimelineTrackHeight - 17, selected ? Brushes.White : new SolidColorBrush(Color.FromArgb(160, 225, 235, 255)), 2);
            }
        }
        var playheadX = TimelineLabelWidth + _timelinePlayheadSeconds * _timelinePixelsPerSecond;
        CanvasLine(TimelineCanvas, playheadX, 0, playheadX, height, new SolidColorBrush(Color.FromRgb(255, 89, 115)), 2);
        CanvasLabel(TimelineCanvas, $"{_timelinePlayheadSeconds:0.00}s", Math.Min(width - 55, playheadX + 5), 15, 52, new SolidColorBrush(Color.FromRgb(255, 150, 165)), 10, FontWeights.Bold);
        if (_timelineDrag is not null) TimelineCanvas.Cursor = _timelineDrag.Mode == TimelineDragMode.Move ? Cursors.SizeAll : Cursors.SizeWE;
        else TimelineCanvas.Cursor = Cursors.Arrow;
    }
    private string? FindTimelineClipId(DependencyObject? source)
    {
        while (source is not null)
        {
            if (source is Border border && border.Tag is string id && _clips.Any(c => c.Id == id)) return id;
            source = VisualTreeHelper.GetParent(source);
        }
        return null;
    }
    private TrackRow? TrackAtTimelineY(double y)
    {
        if (y < TimelineRulerHeight) return null;
        var index = (int)((y - TimelineRulerHeight) / TimelineTrackHeight);
        return _tracks.OrderBy(t => t.Order).ElementAtOrDefault(index);
    }
    private double SnapTimelineTime(double value, HashSet<string> excluded)
    {
        value = Math.Max(0, value);
        if (TimelineSnapCheck?.IsChecked != true) return value;
        var threshold = Math.Max(.06, 8 / _timelinePixelsPerSecond);
        var candidates = new List<double> { Math.Round(value * 4) / 4, _timelinePlayheadSeconds };
        foreach (var clip in _clips)
        {
            if (excluded.Contains(clip.Id)) continue;
            var st = StateFor(clip); var d = Math.Max(0, st.SourceOut - st.SourceIn) / Math.Max(.001, clip.PlaybackRate);
            candidates.Add(st.Start); candidates.Add(st.Start + d);
        }
        var nearest = candidates.Where(t => t >= 0 && double.IsFinite(t)).OrderBy(t => Math.Abs(t - value)).FirstOrDefault(value);
        return Math.Abs(nearest - value) <= threshold ? Math.Max(0, nearest) : value;
    }
    private void SetTimelineSelection(string? primaryId, bool syncHidden = true)
    {
        if (syncHidden)
        {
            _syncingTimelineSelection = true;
            try
            {
                TimelineClips.SelectedItems.Clear();
                foreach (var clip in _clips.Where(c => _selectedTimelineClipIds.Contains(c.Id) && c.Id != primaryId)) TimelineClips.SelectedItems.Add(clip);
                if (primaryId is not null)
                {
                    var primary = _clips.FirstOrDefault(c => c.Id == primaryId);
                    if (primary is not null) TimelineClips.SelectedItems.Add(primary);
                    TimelineTracks.SelectedItem = _tracks.FirstOrDefault(t => t.Id == primary.TrackId);
                }
            }
            finally { _syncingTimelineSelection = false; }
        }
        var selected = primaryId is null ? null : _clips.FirstOrDefault(c => c.Id == primaryId);
        if (selected is null)
        {
            ClipDetails.Text = "Select a clip to see its source and timing.";
            ClipNameText.Text = ""; ClipEnabledCheck.IsChecked = false; ClipVolumeText.Text = "1";
            ClipSpeedText.Text = "1"; ClipOpacityText.Text = "1"; ClipTransformXText.Text = "0"; ClipTransformYText.Text = "0";
            ClipScaleXText.Text = "1"; ClipScaleYText.Text = "1"; ClipRotationText.Text = "0"; ClipShearXText.Text = "0"; ClipShearYText.Text = "0";
        }
        else
        {
            ClipDetails.Text = $"{selected.Name}\nType: {selected.MediaType}\nTrack: {selected.TrackName}\nTimeline: {selected.TimelineStart:0.000}s – {selected.TimelineStart + selected.Duration:0.000}s\nSource: {selected.SourceIn:0.000}s – {selected.SourceOut:0.000}s\nFile: {selected.SourcePath}";
            ClipNameText.Text = selected.Name;
            ClipEnabledCheck.IsChecked = selected.Enabled;
            ClipVolumeText.Text = selected.Volume.ToString("0.###", CultureInfo.InvariantCulture);
            ClipSpeedText.Text = selected.PlaybackRate.ToString("0.###", CultureInfo.InvariantCulture);
            ClipOpacityText.Text = selected.Opacity.ToString("0.###", CultureInfo.InvariantCulture);
            ClipTransformXText.Text = selected.TransformX.ToString("0.###", CultureInfo.InvariantCulture);
            ClipTransformYText.Text = selected.TransformY.ToString("0.###", CultureInfo.InvariantCulture);
            ClipScaleXText.Text = selected.ScaleX.ToString("0.###", CultureInfo.InvariantCulture);
            ClipScaleYText.Text = selected.ScaleY.ToString("0.###", CultureInfo.InvariantCulture);
            ClipRotationText.Text = selected.Rotation.ToString("0.###", CultureInfo.InvariantCulture);
            ClipShearXText.Text = selected.ShearX.ToString("0.###", CultureInfo.InvariantCulture);
            ClipShearYText.Text = selected.ShearY.ToString("0.###", CultureInfo.InvariantCulture);
        }
        RefreshMaskEditorForSelectedClip(); RenderTimelineCanvas();
    }
    private void TimelineCanvas_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        TimelineCanvas.Focus();
        var point = e.GetPosition(TimelineCanvas);
        if (point.Y < TimelineRulerHeight)
        {
            _timelineScrubbing = true;
            _timelinePlayheadSeconds = Math.Max(0, (point.X - TimelineLabelWidth) / _timelinePixelsPerSecond);
            TimelineCanvas.CaptureMouse(); RenderTimelineCanvas(); e.Handled = true; return;
        }
        var id = FindTimelineClipId(e.OriginalSource as DependencyObject);
        if (id is not null)
        {
            var clip = _clips.FirstOrDefault(c => c.Id == id); if (clip is null) return;
            if (e.ClickCount >= 2)
            {
                var asset = _assets.FirstOrDefault(a => a.Id == clip.AssetId);
                if (asset is not null) PreviewAsset(asset, clip.SourceIn);
                e.Handled = true; return;
            }
            var control = Keyboard.IsKeyDown(Key.LeftCtrl) || Keyboard.IsKeyDown(Key.RightCtrl);
            var shift = Keyboard.IsKeyDown(Key.LeftShift) || Keyboard.IsKeyDown(Key.RightShift);
            if (control)
            {
                if (!_selectedTimelineClipIds.Add(id)) _selectedTimelineClipIds.Remove(id);
                else _timelineSelectionAnchorId = id;
                var active = _selectedTimelineClipIds.Contains(id) ? id : _selectedTimelineClipIds.FirstOrDefault();
                SetTimelineSelection(active); e.Handled = true; return;
            }
            if (shift && _timelineSelectionAnchorId is not null)
            {
                var anchor = _clips.FirstOrDefault(c => c.Id == _timelineSelectionAnchorId);
                if (anchor is not null && anchor.TrackId == clip.TrackId)
                {
                    var low = Math.Min(anchor.TimelineStart, clip.TimelineStart); var high = Math.Max(anchor.TimelineStart, clip.TimelineStart);
                    _selectedTimelineClipIds.Clear();
                    foreach (var inRange in _clips.Where(c => c.TrackId == clip.TrackId && c.TimelineStart >= low - 1e-6 && c.TimelineStart <= high + 1e-6)) _selectedTimelineClipIds.Add(inRange.Id);
                    SetTimelineSelection(id); e.Handled = true; return;
                }
            }
            if (!_selectedTimelineClipIds.Contains(id)) { _selectedTimelineClipIds.Clear(); _selectedTimelineClipIds.Add(id); }
            _timelineSelectionAnchorId = id;
            SetTimelineSelection(id);
            var current = StateFor(clip); var left = TimelineLabelWidth + current.Start * _timelinePixelsPerSecond;
            var duration = (current.SourceOut - current.SourceIn) / Math.Max(.001, clip.PlaybackRate); var right = left + duration * _timelinePixelsPerSecond;
            var mode = point.X - left <= 7 && duration * _timelinePixelsPerSecond > 20 ? TimelineDragMode.TrimLeft : right - point.X <= 7 && duration * _timelinePixelsPerSecond > 20 ? TimelineDragMode.TrimRight : TimelineDragMode.Move;
            if (_tracks.FirstOrDefault(t => t.Id == current.TrackId)?.Locked == true) { StatusText.Text = "That track is locked. Unlock it before moving or trimming clips."; e.Handled = true; return; }
            var ids = mode == TimelineDragMode.Move ? _selectedTimelineClipIds.ToList() : new List<string> { id };
            var original = new Dictionary<string, TimelineEditState>(StringComparer.Ordinal);
            foreach (var selectedId in ids) { var row = _clips.FirstOrDefault(c => c.Id == selectedId); if (row is not null) original[selectedId] = StateFor(row); }
            _timelineDrag = new TimelineDragState { PrimaryId = id, Mode = mode, StartPointer = point, Original = original, OriginalTrackId = current.TrackId };
            _timelinePreviewStates = new Dictionary<string, TimelineEditState>(original, StringComparer.Ordinal);
            TimelineCanvas.CaptureMouse(); TimelineCanvas.Cursor = mode == TimelineDragMode.Move ? Cursors.SizeAll : Cursors.SizeWE;
            e.Handled = true; return;
        }
        var hitTrack = TrackAtTimelineY(point.Y);
        if (point.X < TimelineLabelWidth && hitTrack is not null) { TimelineTracks.SelectedItem = hitTrack; StatusText.Text = $"Selected {hitTrack.Name}."; }
        else { _timelinePlayheadSeconds = Math.Max(0, (point.X - TimelineLabelWidth) / _timelinePixelsPerSecond); StatusText.Text = $"Playhead at {_timelinePlayheadSeconds:0.00}s."; }
        if (!Keyboard.IsKeyDown(Key.LeftCtrl) && !Keyboard.IsKeyDown(Key.RightCtrl)) { _selectedTimelineClipIds.Clear(); SetTimelineSelection(null); }
        else RenderTimelineCanvas();
        e.Handled = true;
    }
    private void TimelineCanvas_MouseMove(object sender, MouseEventArgs e)
    {
        if (_timelineScrubbing && e.LeftButton == MouseButtonState.Pressed)
        {
            var scrubPoint = e.GetPosition(TimelineCanvas);
            _timelinePlayheadSeconds = Math.Max(0, (scrubPoint.X - TimelineLabelWidth) / _timelinePixelsPerSecond);
            RenderTimelineCanvas(); e.Handled = true; return;
        }
        var drag = _timelineDrag; if (drag is null || _timelinePreviewStates is null || e.LeftButton != MouseButtonState.Pressed) return;
        var point = e.GetPosition(TimelineCanvas); var dx = (point.X - drag.StartPointer.X) / _timelinePixelsPerSecond;
        var primary = _clips.FirstOrDefault(c => c.Id == drag.PrimaryId); if (primary is null) return;
        var primaryStart = drag.Original[drag.PrimaryId].Start;
        if (drag.Mode == TimelineDragMode.Move)
        {
            var desired = Math.Max(0, primaryStart + dx);
            var excluded = drag.Original.Keys.ToHashSet(StringComparer.Ordinal);
            var snapped = SnapTimelineTime(desired, excluded); var delta = snapped - primaryStart;
            foreach (var original in drag.Original)
            {
                var old = original.Value; var trackId = old.TrackId;
                if (original.Key == drag.PrimaryId)
                {
                    var targetTrack = TrackAtTimelineY(point.Y);
                    var targetClip = _clips.First(c => c.Id == original.Key);
                    if (targetTrack is not null && !targetTrack.Locked && ((targetClip.MediaType == "audio") == (targetTrack.Type == "audio"))) trackId = targetTrack.Id;
                }
                _timelinePreviewStates[original.Key] = old with { Start = Math.Max(0, old.Start + delta), TrackId = trackId };
            }
        }
        else if (drag.Mode == TimelineDragMode.TrimLeft)
        {
            var original = drag.Original[drag.PrimaryId]; var desiredStart = Math.Max(0, primaryStart + dx);
            var snappedStart = SnapTimelineTime(desiredStart, new HashSet<string>(drag.Original.Keys, StringComparer.Ordinal));
            var delta = snappedStart - primaryStart; var nextIn = original.SourceIn + delta * primary.PlaybackRate;
            if (nextIn >= 0 && nextIn < original.SourceOut - .05 * primary.PlaybackRate)
            {
                if (TimelineRippleCheck.IsChecked == true)
                {
                    // Ripple-trim the head: keep the clip's original start, shorten/extend its
                    // duration, then shift later clips by the inverse duration delta.
                    _timelinePreviewStates[drag.PrimaryId] = original with { SourceIn = nextIn };
                    var durationDelta = -delta;
                    var originalEnd = original.Start + (original.SourceOut - original.SourceIn) / primary.PlaybackRate;
                    foreach (var other in _clips.Where(c => c.Id != drag.PrimaryId && c.TrackId == original.TrackId && c.TimelineStart >= originalEnd - 1e-6))
                    {
                        var otherState = drag.Original.TryGetValue(other.Id, out var captured) ? captured : new TimelineEditState(other.TimelineStart, other.SourceIn, other.SourceOut, other.TrackId);
                        _timelinePreviewStates[other.Id] = otherState with { Start = Math.Max(0, otherState.Start + durationDelta) };
                    }
                }
                else _timelinePreviewStates[drag.PrimaryId] = original with { Start = snappedStart, SourceIn = nextIn };
            }
        }
        else
        {
            var original = drag.Original[drag.PrimaryId]; var originalEnd = original.Start + (original.SourceOut - original.SourceIn) / primary.PlaybackRate;
            var desiredEnd = Math.Max(original.Start + .05, originalEnd + dx);
            var snappedEnd = SnapTimelineTime(desiredEnd, new HashSet<string>(drag.Original.Keys, StringComparer.Ordinal));
            var nextOut = original.SourceOut + (snappedEnd - originalEnd) * primary.PlaybackRate;
            var asset = _assets.FirstOrDefault(a => a.Id == primary.AssetId);
            if (nextOut > original.SourceIn + .05 * primary.PlaybackRate && (asset is null || asset.Duration <= 0 || nextOut <= asset.Duration + 1e-6))
            {
                _timelinePreviewStates[drag.PrimaryId] = original with { SourceOut = nextOut };
                if (TimelineRippleCheck.IsChecked == true)
                {
                    var durationDelta = snappedEnd - originalEnd;
                    foreach (var other in _clips.Where(c => c.Id != drag.PrimaryId && c.TrackId == original.TrackId && c.TimelineStart >= originalEnd - 1e-6))
                    {
                        var otherState = drag.Original.TryGetValue(other.Id, out var captured) ? captured : new TimelineEditState(other.TimelineStart, other.SourceIn, other.SourceOut, other.TrackId);
                        _timelinePreviewStates[other.Id] = otherState with { Start = Math.Max(0, otherState.Start + durationDelta) };
                    }
                }
            }
        }
        RenderTimelineCanvas(); e.Handled = true;
    }
    private void TimelineCanvas_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        if (_timelineScrubbing)
        {
            _timelineScrubbing = false; TimelineCanvas.ReleaseMouseCapture(); StatusText.Text = $"Playhead at {_timelinePlayheadSeconds:0.00}s."; RenderTimelineCanvas(); e.Handled = true; return;
        }
        if (_timelineDrag is null || _timelinePreviewStates is null) return;
        TimelineCanvas.ReleaseMouseCapture(); var edits = new JsonArray();
        foreach (var pair in _timelinePreviewStates)
        {
            var clip = _clips.FirstOrDefault(c => c.Id == pair.Key); if (clip is null) continue;
            var before = _timelineDrag.Original.TryGetValue(pair.Key, out var orig) ? orig : new TimelineEditState(clip.TimelineStart, clip.SourceIn, clip.SourceOut, clip.TrackId);
            var after = pair.Value;
            if (Math.Abs(before.Start - after.Start) > 1e-6 || before.TrackId != after.TrackId)
                edits.Add(new JsonObject { ["op"] = "move", ["clipId"] = pair.Key, ["start"] = after.Start, ["trackId"] = after.TrackId });
            if (Math.Abs(before.SourceIn - after.SourceIn) > 1e-6 || Math.Abs(before.SourceOut - after.SourceOut) > 1e-6)
                edits.Add(new JsonObject { ["op"] = "range", ["clipId"] = pair.Key, ["sourceIn"] = after.SourceIn, ["sourceOut"] = after.SourceOut });
        }
        var hadDrag = _timelineDrag; _timelineDrag = null; _timelinePreviewStates = null; TimelineCanvas.Cursor = Cursors.Arrow;
        if (edits.Count == 0) { RenderTimelineCanvas(); return; }
        ApplyClipEditOperations(edits, hadDrag.Mode switch { TimelineDragMode.Move => "Moved clip(s).", TimelineDragMode.TrimLeft => "Trimmed clip start.", _ => "Trimmed clip end." });
    }
    private void ApplyClipEditOperations(JsonArray edits, string success)
    {
        if (edits.Count == 0) return;
        var error = new StringBuilder(2048);
        if (Native.frosty_project_apply_clip_edits_json(_project, edits.ToJsonString(), error, error.Capacity) == 0)
        {
            MessageBox.Show(this, error.ToString(), "Timeline edit rejected", MessageBoxButton.OK, MessageBoxImage.Warning);
            _timelinePreviewStates = null; _timelineDrag = null; RenderTimelineCanvas(); return;
        }
        MarkDirty(); RefreshTimeline(); StatusText.Text = success;
    }
    private void TimelineSplitAtPlayhead_Click(object sender, RoutedEventArgs e)
    {
        var candidates = _clips.Where(c => _selectedTimelineClipIds.Contains(c.Id)).ToList();
        if (candidates.Count == 0 && TimelineClips.SelectedItem is ClipRow selected) candidates.Add(selected);
        var edits = new JsonArray();
        foreach (var clip in candidates)
        {
            if (_tracks.FirstOrDefault(t => t.Id == clip.TrackId)?.Locked == true) continue;
            var start = clip.TimelineStart; var end = start + clip.Duration;
            if (_timelinePlayheadSeconds <= start + 1e-4 || _timelinePlayheadSeconds >= end - 1e-4) continue;
            edits.Add(new JsonObject { ["op"] = "split", ["clipId"] = clip.Id, ["start"] = _timelinePlayheadSeconds });
        }
        if (edits.Count == 0) { StatusText.Text = "Move the playhead inside one or more unlocked selected clips to split them."; return; }
        ApplyClipEditOperations(edits, $"Split {edits.Count} clip(s) at {_timelinePlayheadSeconds:0.00}s.");
    }
    private void MainWindow_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (!TimelineCanvas.IsKeyboardFocusWithin) return;
        var control = Keyboard.IsKeyDown(Key.LeftCtrl) || Keyboard.IsKeyDown(Key.RightCtrl);
        if (control && e.Key == Key.K) { TimelineSplitAtPlayhead_Click(this, new RoutedEventArgs()); e.Handled = true; }
        else if (control && e.Key == Key.A) { TimelineSelectAll_Click(this, new RoutedEventArgs()); e.Handled = true; }
        else if (control && e.Key == Key.Z) { Undo_Click(this, new RoutedEventArgs()); e.Handled = true; }
        else if (control && e.Key == Key.Y) { Redo_Click(this, new RoutedEventArgs()); e.Handled = true; }
        else if (e.Key == Key.Delete && _selectedTimelineClipIds.Count > 0) { RippleDeleteSelected_Click(this, new RoutedEventArgs()); e.Handled = true; }
    }
    private void TimelineSelectAll_Click(object sender, RoutedEventArgs e)
    {
        _selectedTimelineClipIds.Clear(); foreach (var clip in _clips) _selectedTimelineClipIds.Add(clip.Id);
        _timelineSelectionAnchorId = _clips.FirstOrDefault()?.Id;
        SetTimelineSelection(_clips.FirstOrDefault()?.Id);
    }
    private void TimelineZoomOut_Click(object sender, RoutedEventArgs e) { _timelinePixelsPerSecond = Math.Max(18, _timelinePixelsPerSecond / 1.25); RenderTimelineCanvas(); }
    private void TimelineZoomIn_Click(object sender, RoutedEventArgs e) { _timelinePixelsPerSecond = Math.Min(130, _timelinePixelsPerSecond * 1.25); RenderTimelineCanvas(); }
    private void TimelineInsertGap_Click(object sender, RoutedEventArgs e) => ApplyRangeTimelineEdit("insert-gap", _timelinePlayheadSeconds, _timelinePlayheadSeconds + 1, "Inserted a one-second timeline gap.");
    private void TimelineRippleDeleteRange_Click(object sender, RoutedEventArgs e) => ApplyRangeTimelineEdit("ripple-delete", _timelinePlayheadSeconds, _timelinePlayheadSeconds + 1, "Ripple-deleted one second from the timeline.");
    private void ApplyRangeTimelineEdit(string operation, double start, double end, string message)
    {
        if (end <= start || !double.IsFinite(start) || !double.IsFinite(end)) return;
        var error = new StringBuilder(2048);
        if (Native.frosty_project_timeline_edit(_project, operation, start, end, error, error.Capacity) == 0) { MessageBox.Show(this, error.ToString(), "Timeline range edit failed", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
        MarkDirty(); RefreshTimeline(); StatusText.Text = message;
    }
    private void RippleDeleteSelected_Click(object sender, RoutedEventArgs e)
    {
        var selected = _clips.Where(c => _selectedTimelineClipIds.Contains(c.Id)).ToList();
        if (selected.Count == 0 && TimelineClips.SelectedItem is ClipRow one) selected.Add(one);
        if (selected.Count == 0) { StatusText.Text = "Select one or more clips first."; return; }
        if (MessageBox.Show(this, $"Ripple-delete {selected.Count} selected clip(s) and close the gaps on their tracks?", "Ripple delete", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        var selectedIds = selected.Select(c => c.Id).ToHashSet(StringComparer.Ordinal); var edits = new JsonArray();
        foreach (var clip in selected) edits.Add(new JsonObject { ["op"] = "remove", ["clipId"] = clip.Id });
        foreach (var group in selected.GroupBy(c => c.TrackId))
        {
            var intervals = group.Select(c => (Start: c.TimelineStart, End: c.TimelineStart + c.Duration)).OrderBy(x => x.Start).ToList();
            var merged = new List<(double Start, double End)>();
            foreach (var interval in intervals)
            {
                if (merged.Count == 0 || interval.Start > merged[^1].End + 1e-6) merged.Add(interval);
                else merged[^1] = (merged[^1].Start, Math.Max(merged[^1].End, interval.End));
            }
            foreach (var clip in _clips.Where(c => c.TrackId == group.Key && !selectedIds.Contains(c.Id)))
            {
                var shift = merged.Where(interval => interval.End <= clip.TimelineStart + 1e-6).Sum(interval => interval.End - interval.Start);
                if (shift > 1e-6) edits.Add(new JsonObject { ["op"] = "move", ["clipId"] = clip.Id, ["start"] = Math.Max(0, clip.TimelineStart - shift), ["trackId"] = clip.TrackId });
            }
        }
        _selectedTimelineClipIds.Clear(); ApplyClipEditOperations(edits, "Ripple-deleted selected clips and closed their track gaps.");
    }
    private void ApplyClipProperties_Click(object sender, RoutedEventArgs e)
    {
        var clip = TimelineClips.SelectedItem as ClipRow;
        if (clip is null) { StatusText.Text = "Select a clip first."; return; }
        if (string.IsNullOrWhiteSpace(ClipNameText.Text)) { MessageBox.Show(this, "Clip name cannot be empty.", "Invalid clip property", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
        bool Read(TextBox box, string field, out double value)
        {
            if (!double.TryParse(box.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out value) || !double.IsFinite(value)) { MessageBox.Show(this, $"{field} must be a valid finite number.", "Invalid clip property", MessageBoxButton.OK, MessageBoxImage.Warning); return false; }
            return true;
        }
        if (!Read(ClipVolumeText, "Volume", out var volume) || !Read(ClipSpeedText, "Speed", out var speed) || !Read(ClipOpacityText, "Opacity", out var opacity) || !Read(ClipTransformXText, "Transform X", out var tx) || !Read(ClipTransformYText, "Transform Y", out var ty) || !Read(ClipScaleXText, "Scale X", out var sx) || !Read(ClipScaleYText, "Scale Y", out var sy) || !Read(ClipRotationText, "Rotation", out var rotation) || !Read(ClipShearXText, "Shear X", out var shearX) || !Read(ClipShearYText, "Shear Y", out var shearY)) return;
        var edits = new JsonArray();
        void AddNumber(string property, double value) => edits.Add(new JsonObject { ["op"] = "property", ["clipId"] = clip.Id, ["property"] = property, ["value"] = value });
        edits.Add(new JsonObject { ["op"] = "property", ["clipId"] = clip.Id, ["property"] = "name", ["value"] = ClipNameText.Text.Trim() });
        edits.Add(new JsonObject { ["op"] = "property", ["clipId"] = clip.Id, ["property"] = "enabled", ["value"] = ClipEnabledCheck.IsChecked == true });
        AddNumber("volume", volume); AddNumber("playbackRate", speed); AddNumber("opacity", opacity);
        AddNumber("transform.x", tx); AddNumber("transform.y", ty); AddNumber("transform.scaleX", sx); AddNumber("transform.scaleY", sy);
        AddNumber("transform.rotation", rotation); AddNumber("transform.shearX", shearX); AddNumber("transform.shearY", shearY);
        ApplyClipEditOperations(edits, "Applied clip name, enable state, audio, timing and transform properties.");
    }

    private void MoveSelectedClip(double delta)
    {
        if (TimelineClips.SelectedItem is not ClipRow clip) { StatusText.Text = "Select a clip first."; return; }
        var error = new StringBuilder(2048); var next = Math.Max(0, clip.TimelineStart + delta);
        if (Native.frosty_project_move_clip(_project, clip.Id, next, error, error.Capacity) == 0) { MessageBox.Show(this, error.ToString(), "Clip move failed", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
        MarkDirty(); RefreshTimeline(); _selectedTimelineClipIds.Clear(); _selectedTimelineClipIds.Add(clip.Id); SetTimelineSelection(clip.Id); StatusText.Text = $"Moved {clip.Name} to {next:0.00}s.";
    }
    private void MoveClipEarlier_Click(object sender, RoutedEventArgs e) => MoveSelectedClip(-1);
    private void MoveClipLater_Click(object sender, RoutedEventArgs e) => MoveSelectedClip(1);
    private void TrimSelectedClip(double inDelta, double outDelta)
    {
        if (TimelineClips.SelectedItem is not ClipRow clip) { StatusText.Text = "Select a clip first."; return; }
        var nextIn = clip.SourceIn + inDelta; var nextOut = clip.SourceOut + outDelta;
        if (nextIn < 0 || nextOut <= nextIn) { StatusText.Text = "Trim would create an invalid or empty source range."; return; }
        var error = new StringBuilder(2048);
        if (Native.frosty_project_set_clip_range(_project, clip.Id, nextIn, nextOut, error, error.Capacity) == 0)
        {
            MessageBox.Show(this, error.ToString(), "Clip trim failed", MessageBoxButton.OK, MessageBoxImage.Warning); return;
        }
        MarkDirty(); RefreshTimeline(); _selectedTimelineClipIds.Clear(); _selectedTimelineClipIds.Add(clip.Id); SetTimelineSelection(clip.Id);
        StatusText.Text = $"Updated source range for {clip.Name}: {nextIn:0.00}s–{nextOut:0.00}s.";
    }
    private void TrimInEarlier_Click(object sender, RoutedEventArgs e) => TrimSelectedClip(-0.5, 0);
    private void TrimInLater_Click(object sender, RoutedEventArgs e) => TrimSelectedClip(0.5, 0);
    private void TrimOutEarlier_Click(object sender, RoutedEventArgs e) => TrimSelectedClip(0, -0.5);
    private void TrimOutLater_Click(object sender, RoutedEventArgs e) => TrimSelectedClip(0, 0.5);

    private void SetSelectedEffect(string type, string parameter, double value)
    {
        if (TimelineClips.SelectedItem is not ClipRow clip) { StatusText.Text="Select a clip first."; return; }
        var error=new StringBuilder(2048);
        if(Native.frosty_project_set_clip_effect(_project,clip.Id,type,parameter,value,1,error,error.Capacity)==0){MessageBox.Show(this,error.ToString(),"Effect update failed",MessageBoxButton.OK,MessageBoxImage.Warning);return;}
        MarkDirty(); RefreshTimeline(); _selectedTimelineClipIds.Clear(); _selectedTimelineClipIds.Add(clip.Id); SetTimelineSelection(clip.Id); StatusText.Text=$"Applied {type} effect to {clip.Name}. Effects are rendered during export.";
    }
    private void AdjustSelectedClipVolume(double delta)
    {
        if(TimelineClips.SelectedItem is not ClipRow clip){StatusText.Text="Select a clip first.";return;}
        try { using var doc=JsonDocument.Parse(PtrString(Native.frosty_project_json(_project))); var current=doc.RootElement.GetProperty("sequences").EnumerateArray().SelectMany(x=>x.GetProperty("clips").EnumerateArray()).FirstOrDefault(x=>GetString(x,"id")==clip.Id); var volume=Math.Clamp(GetDouble(current,"volume",1)+delta,0,4); var error=new StringBuilder(2048); if(Native.frosty_project_set_clip_volume(_project,clip.Id,volume,error,error.Capacity)==0)throw new InvalidOperationException(error.ToString()); MarkDirty(); RefreshTimeline(); _selectedTimelineClipIds.Clear(); _selectedTimelineClipIds.Add(clip.Id); SetTimelineSelection(clip.Id); StatusText.Text=$"Clip volume set to {volume:0.00}× for {clip.Name}."; } catch(Exception ex){MessageBox.Show(this,ex.Message,"Volume update failed",MessageBoxButton.OK,MessageBoxImage.Warning);}
    }
    private void VolumeDown_Click(object sender,RoutedEventArgs e)=>AdjustSelectedClipVolume(-0.25);
    private void VolumeUp_Click(object sender,RoutedEventArgs e)=>AdjustSelectedClipVolume(0.25);
    private void BrightnessEffect_Click(object sender,RoutedEventArgs e)=>SetSelectedEffect("brightness","value",0.1);
    private void ContrastEffect_Click(object sender,RoutedEventArgs e)=>SetSelectedEffect("contrast","value",1.15);
    private void BlurEffect_Click(object sender,RoutedEventArgs e)=>SetSelectedEffect("blur","amount",2);
    private void ClearEffects_Click(object sender,RoutedEventArgs e)
    {
        if(TimelineClips.SelectedItem is not ClipRow clip){StatusText.Text="Select a clip first.";return;}
        var error=new StringBuilder(2048);if(Native.frosty_project_set_clip_effect(_project,clip.Id,"clear","value",0,0,error,error.Capacity)==0){MessageBox.Show(this,error.ToString(),"Effect update failed",MessageBoxButton.OK,MessageBoxImage.Warning);return;}
        MarkDirty(); RefreshTimeline(); _selectedTimelineClipIds.Clear(); _selectedTimelineClipIds.Add(clip.Id); SetTimelineSelection(clip.Id); StatusText.Text=$"Cleared effects from {clip.Name}.";
    }

    private void RemoveClip_Click(object sender, RoutedEventArgs e)
    {
        if (TimelineClips.SelectedItem is not ClipRow clip) { StatusText.Text = "Select a clip first."; return; }
        if (MessageBox.Show(this, $"Remove '{clip.Name}' from the timeline? The media asset will remain in the project.", "Remove clip", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        var error = new StringBuilder(2048);
        if (Native.frosty_project_remove_clip(_project, clip.Id, error, error.Capacity) == 0) { MessageBox.Show(this, error.ToString(), "Clip removal failed", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
        _selectedTimelineClipIds.Remove(clip.Id); MarkDirty(); RefreshTimeline(); StatusText.Text = $"Removed {clip.Name} from the timeline.";
    }
    private void MediaAssets_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_refreshing || MediaAssets.SelectedItem is not MediaAsset asset) return;
        PreviewAsset(asset, 0);
    }
    private void MediaAssets_MouseDoubleClick(object sender, MouseButtonEventArgs e) { if (MediaAssets.SelectedItem is MediaAsset asset) PreviewAsset(asset, 0); }
    private void TimelineClips_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_syncingTimelineSelection || _refreshing) return;
        _selectedTimelineClipIds.Clear(); foreach (ClipRow item in TimelineClips.SelectedItems) _selectedTimelineClipIds.Add(item.Id);
        SetTimelineSelection((TimelineClips.SelectedItem as ClipRow)?.Id, false);
    }
    private void TimelineClips_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (TimelineClips.SelectedItem is not ClipRow clip) return;
        var asset = _assets.FirstOrDefault(a => a.Id == clip.AssetId);
        if (asset is not null) PreviewAsset(asset, clip.SourceIn);
    }
    private void PreviewAsset(MediaAsset asset, double sourceIn)
    {
        if (!System.IO.File.Exists(asset.Path)) { PreviewPlaceholder.Visibility = Visibility.Visible; PreviewPlaceholder.Text = "Source file missing; relink it before preview."; PreviewStatus.Text = asset.Path; StatusText.Text = "Cannot preview missing asset: " + asset.Name; return; }
        StopPreview(); _pendingPreviewSeek = Math.Max(0, sourceIn); PreviewPlaceholder.Visibility = Visibility.Collapsed;
        try
        {
            if (asset.MediaType == "image")
            {
                PreviewPlayer.Visibility = Visibility.Collapsed; PreviewStill.Visibility = Visibility.Visible;
                var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.UriSource = new Uri(asset.Path, UriKind.Absolute); bitmap.EndInit(); bitmap.Freeze(); PreviewStill.Source = bitmap;
                PreviewStatus.Text = $"Still image · {asset.Name}"; return;
            }
            PreviewStill.Visibility = Visibility.Collapsed; PreviewPlayer.Visibility = Visibility.Visible;
            PreviewStatus.Text = $"Loading preview · {asset.Name}"; PreviewPlayer.Source = new Uri(asset.Path, UriKind.Absolute);
        }
        catch (Exception ex) { PreviewPlaceholder.Visibility = Visibility.Visible; PreviewPlaceholder.Text = "Could not load preview."; PreviewStatus.Text = ex.Message; StatusText.Text = "Preview load failed."; }
    }
    private void PreviewPlayer_MediaOpened(object sender, RoutedEventArgs e)
    {
        try { if (_pendingPreviewSeek > 0) PreviewPlayer.Position = TimeSpan.FromSeconds(_pendingPreviewSeek); PreviewPlayer.Play(); _previewPlaying = true; PreviewStatus.Text = "Preview playing"; }
        catch (Exception ex) { PreviewStatus.Text = "Preview opened but seeking failed: " + ex.Message; }
    }
    private void PreviewPlayer_MediaFailed(object sender, ExceptionRoutedEventArgs e)
    {
         _previewPlaying = false; PreviewPlaceholder.Visibility = Visibility.Visible; PreviewPlaceholder.Text = "This media format could not be previewed by the Windows media stack. Install a supported codec or use the Frosty FFmpeg renderer.";
        PreviewStatus.Text = e.ErrorException?.Message ?? "Media playback failed";
    }

    private async void RenderSequencePreview_Click(object sender, RoutedEventArgs e)
    {
        if(_project==IntPtr.Zero)return;
        try {
            StopPreview(); PreviewPlaceholder.Visibility=Visibility.Visible; PreviewPlaceholder.Text="Rendering the native sequence for preview…"; StatusText.Text="Rendering sequence preview with FFmpeg…";
            var path=System.IO.Path.Combine(System.IO.Path.GetTempPath(),"frosty-native-preview-"+Guid.NewGuid().ToString("N")+".mp4");
            var progress=new Progress<string>(v=>{StatusText.Text=v;PreviewStatus.Text=v;});
            await NativeWorkflow.ExportAsync(PtrString(Native.frosty_project_json(_project)),path,0,1,1,0,1,"libx264",progress);
            if(_renderedPreviewPath is not null)try{System.IO.File.Delete(_renderedPreviewPath);}catch{}
            _renderedPreviewPath=path; PreviewAsset(new MediaAsset{Id="rendered-preview",Path=path,Name="Rendered sequence preview",MediaType="video",Duration=0,Missing=false},0);
            StatusText.Text="Rendered sequence preview ready. This is an offline render, not real-time GPU playback.";
        } catch(Exception ex) { PreviewPlaceholder.Visibility=Visibility.Visible; PreviewPlaceholder.Text="Sequence preview render failed."; PreviewStatus.Text=ex.Message; StatusText.Text="Preview render failed: "+ex.Message; }
    }

    private async void GpuTimelinePlay_Click(object sender, RoutedEventArgs e)
    {
        if (_project == IntPtr.Zero) { StatusText.Text = "Create or open a project first."; return; }
        try
        {
            StopPreview();
            PreviewPlayer.Visibility = Visibility.Collapsed; PreviewStill.Visibility = Visibility.Collapsed;
            GpuPreviewSurface.Visibility = Visibility.Visible; PreviewPlaceholder.Visibility = Visibility.Collapsed;
            await GpuPreviewSurface.StartTimelineAsync(PtrString(Native.frosty_project_json(_project)));
        }
        catch (Exception ex)
        {
            try { GpuPreviewSurface.StopTimeline(); } catch { }
            GpuPreviewSurface.Visibility = Visibility.Collapsed; PreviewPlaceholder.Visibility = Visibility.Visible;
            PreviewPlaceholder.Text = "GPU timeline preview could not start. Verify the Windows native build, Direct3D 11, and FFmpeg.";
            PreviewStatus.Text = ex.Message; StatusText.Text = "GPU preview failed: " + ex.Message;
        }
    }
    private void GpuTimelinePause_Click(object sender, RoutedEventArgs e)
    {
        try { GpuPreviewSurface.TogglePause(); } catch (Exception ex) { StatusText.Text = "GPU preview pause failed: " + ex.Message; }
    }
    private void GpuPreviewSurface_StatusChanged(string message)
    {
        PreviewStatus.Text = message; StatusText.Text = message;
    }

    private void PlayPause_Click(object sender, RoutedEventArgs e)
    {
        if (PreviewStill.Visibility == Visibility.Visible) { StatusText.Text = "Still images do not need playback."; return; }
        if (PreviewPlayer.Source is null) { StatusText.Text = "Select a media asset or timeline clip to preview."; return; }
        try { if (_previewPlaying) { PreviewPlayer.Pause(); _previewPlaying = false; PreviewStatus.Text = "Preview paused"; } else { PreviewPlayer.Play(); _previewPlaying = true; PreviewStatus.Text = "Preview playing"; } }
        catch (Exception ex) { StatusText.Text = "Could not control preview: " + ex.Message; }
    }
    private void StopPreview_Click(object sender, RoutedEventArgs e) { StopPreview(); PreviewStatus.Text = "Preview stopped"; }
    private void StopPreview()
    {
        try { GpuPreviewSurface.StopTimeline(); GpuPreviewSurface.Visibility = Visibility.Collapsed; } catch { }
        try { PreviewPlayer.Stop(); PreviewPlayer.Source = null; } catch { }
        PreviewStill.Source = null; PreviewStill.Visibility = Visibility.Collapsed; PreviewPlayer.Visibility = Visibility.Visible; _previewPlaying = false;
    }
    private void Undo_Click(object sender, RoutedEventArgs e) { if (Native.frosty_project_undo(_project) != 0) { MarkDirty(); RefreshTimeline(); StatusText.Text = "Undid the previous native timeline operation."; } else StatusText.Text = "Nothing to undo."; }
    private void Redo_Click(object sender, RoutedEventArgs e) { if (Native.frosty_project_redo(_project) != 0) { MarkDirty(); RefreshTimeline(); StatusText.Text = "Redid the previous native timeline operation."; } else StatusText.Text = "Nothing to redo."; }
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

    private async void ExportVideo_Click(object sender, RoutedEventArgs e)
    {
        if (_project == IntPtr.Zero) { StatusText.Text = "Create or open a project first."; return; }
        var save = new SaveFileDialog { Title = "Export Frosty sequence", Filter = "MP4 video (*.mp4)|*.mp4", DefaultExt = ".mp4", FileName = "Frosty-export.mp4" };
        if (save.ShowDialog(this) != true) return;
        var panel = new StackPanel { Margin = new Thickness(16), Width = 390 };
        panel.Children.Add(new TextBlock { Text = "Export settings", FontSize = 18, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0,0,0,12) });
        TextBox AddField(string label, string value) { panel.Children.Add(new TextBlock { Text = label, Margin = new Thickness(0,6,0,3) }); var box = new TextBox { Text = value, MinWidth = 280 }; panel.Children.Add(box); return box; }
        var bright=AddField("Brightness (-1 to 1)","0"); var contrast=AddField("Contrast (0 to 2)","1"); var sat=AddField("Saturation (0 to 3)","1"); var blur=AddField("Gaussian blur sigma (0 to 20)","0"); var gain=AddField("Master audio gain (0 to 4)","1");
        panel.Children.Add(new TextBlock { Text = "Video encoder", Margin = new Thickness(0,8,0,3) }); var enc = new ComboBox { ItemsSource = new[] { "libx264", "h264_nvenc", "h264_qsv", "h264_amf" }, SelectedIndex = 0 }; panel.Children.Add(enc);
        var start = new Button { Content = "Start export", Margin = new Thickness(0,14,0,0), Padding = new Thickness(10) }; panel.Children.Add(start);
        var win = new Window { Title="Frosty export", Owner=this, Content=panel, SizeToContent=SizeToContent.WidthAndHeight, WindowStartupLocation=WindowStartupLocation.CenterOwner, ResizeMode=ResizeMode.NoResize, Background=(System.Windows.Media.Brush)new System.Windows.Media.BrushConverter().ConvertFromString("#151A24")! };
        start.Click += async (_, _) => {
            if (!double.TryParse(bright.Text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var b) || b < -1 || b > 1 || !double.TryParse(contrast.Text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var c) || c < 0 || c > 2 || !double.TryParse(sat.Text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var s) || s < 0 || s > 3 || !double.TryParse(blur.Text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var bl) || bl < 0 || bl > 20 || !double.TryParse(gain.Text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var g) || g < 0 || g > 4) { MessageBox.Show(win,"Enter valid numeric export values within the shown ranges."); return; }
            start.IsEnabled=false; start.Content="Exporting…"; StatusText.Text="Export in progress…";
            try { var progress=new Progress<string>(v=>{StatusText.Text=v; start.Content=v.Length>32?v[..32]:v;}); await NativeWorkflow.ExportAsync(PtrString(Native.frosty_project_json(_project)),save.FileName,b,c,s,bl,g,enc.SelectedItem?.ToString()??"libx264",progress); MessageBox.Show(this,"Export completed successfully:\n"+save.FileName,"Frosty export",MessageBoxButton.OK,MessageBoxImage.Information); win.Close(); }
            catch(Exception ex) { MessageBox.Show(win,ex.Message,"Export failed",MessageBoxButton.OK,MessageBoxImage.Error); start.IsEnabled=true; start.Content="Retry export"; }
        };
        win.ShowDialog();
    }

    private async void AiEditor_Click(object sender, RoutedEventArgs e)
    {
        if (_project == IntPtr.Zero) return;
        var panel=new StackPanel{Margin=new Thickness(16),Width=560};
        panel.Children.Add(new TextBlock{Text="Frosty AI editing assistant",FontSize=18,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,0,0,10)});
        panel.Children.Add(new TextBlock{Text="Uses OpenRouter. Your API key is used for this request only and is not saved by Frosty.",TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,0,0,8)});
        panel.Children.Add(new TextBlock{Text="API key"}); var key=new PasswordBox{Margin=new Thickness(0,3,0,8)}; panel.Children.Add(key);
        panel.Children.Add(new TextBlock{Text="Model ID"}); var model=new TextBox{Text="openai/gpt-4o-mini",Margin=new Thickness(0,3,0,8)}; panel.Children.Add(model);
        panel.Children.Add(new TextBlock{Text="What should Frosty help with?"}); var request=new TextBox{AcceptsReturn=true,TextWrapping=TextWrapping.Wrap,Height=80,Text="Review this edit and suggest improvements to pacing, audio balance, effects and export settings.",Margin=new Thickness(0,3,0,8)}; panel.Children.Add(request);
        var output=new TextBox{IsReadOnly=true,AcceptsReturn=true,TextWrapping=TextWrapping.Wrap,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,MinHeight=200}; panel.Children.Add(output);
        var ask=new Button{Content="Generate edit plan",Padding=new Thickness(10),Margin=new Thickness(0,8,0,0)}; panel.Children.Add(ask);
        var apply=new Button{Content="Validate, review and apply edits atomically",Padding=new Thickness(10),Margin=new Thickness(0,5,0,0),IsEnabled=false}; panel.Children.Add(apply);
        var win=new Window{Title="Frosty AI assistant",Owner=this,Content=panel,Width=620,Height=650,WindowStartupLocation=WindowStartupLocation.CenterOwner,Background=(System.Windows.Media.Brush)new System.Windows.Media.BrushConverter().ConvertFromString("#151A24")!};
        string lastPlan="";
        ask.Click+=async(_,_)=>{if(string.IsNullOrWhiteSpace(key.Password)||string.IsNullOrWhiteSpace(request.Text)||string.IsNullOrWhiteSpace(model.Text)){MessageBox.Show(win,"Enter an API key, model ID and request.");return;} ask.IsEnabled=false; apply.IsEnabled=false; output.Text="Analyzing current project…"; try{lastPlan=await NativeWorkflow.AskAiAsync(key.Password,model.Text.Trim(),request.Text,PtrString(Native.frosty_project_json(_project))); output.Text=lastPlan; apply.IsEnabled=true;StatusText.Text="AI edit plan generated. Review it before applying.";}catch(Exception ex){output.Text="AI request failed: "+ex.Message;}finally{ask.IsEnabled=true;}};
        apply.Click+=(_,_)=>{
            try {
                var raw=lastPlan.Trim(); var start=raw.IndexOf('{'); var end=raw.LastIndexOf('}'); if(start<0||end<=start)throw new InvalidOperationException("The model did not return a JSON edit plan.");
                using var plan=JsonDocument.Parse(raw[start..(end+1)]); if(!plan.RootElement.TryGetProperty("ops",out var ops)||ops.ValueKind!=JsonValueKind.Array)throw new InvalidOperationException("The edit plan has no ops array.");
                using var project=JsonDocument.Parse(PtrString(Native.frosty_project_json(_project)));
                var batch=NativeWorkflow.NormalizeAiOperations(ops,project.RootElement,out var descriptions);
                var preview=string.Join(Environment.NewLine,descriptions.Select((description,index)=>$"{index+1}. {description}"));
                if(MessageBox.Show(win,$"Frosty validated {descriptions.Count} operation(s). The native engine applies this batch atomically: if any operation fails, none are committed.\n\n{preview}\n\nApply these changes?","Review native AI edit plan",MessageBoxButton.YesNo,MessageBoxImage.Question)!=MessageBoxResult.Yes)return;
                var error=new StringBuilder(4096);
                if(Native.frosty_project_apply_clip_edits_json(_project,batch.ToJsonString(),error,error.Capacity)==0)throw new InvalidOperationException(error.ToString());
                MarkDirty();RefreshTimeline();StatusText.Text=$"Applied {descriptions.Count} validated AI edit operation(s).";output.Text+=$"\n\nApplied {descriptions.Count} validated operation(s) as one undoable transaction. Review the timeline and save if correct.";
            } catch(Exception ex){MessageBox.Show(win,ex.Message,"AI plan rejected; no edits applied",MessageBoxButton.OK,MessageBoxImage.Warning);output.Text+="\n\nPlan rejected: "+ex.Message;}
        };
        win.ShowDialog();
    }

    private void UpdateFrosty_Click(object sender, RoutedEventArgs e)
    {
        var confirmation = MessageBox.Show(this, "Frosty will download the latest source, run regression tests, rebuild the native app, and replace this installation. This may take several minutes and requires internet access and Windows build prerequisites. Your projects and media are kept. Continue?", "Update Frosty", MessageBoxButton.YesNo, MessageBoxImage.Information, MessageBoxResult.Yes);
        if (confirmation != MessageBoxResult.Yes) return;
        if (_dirty)
        {
            CreateRecoverySnapshot();
            var saveChoice = MessageBox.Show(this, "This project has unsaved changes. A recovery snapshot was attempted. Continue with the update?", "Unsaved project changes", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No);
            if (saveChoice != MessageBoxResult.Yes) return;
        }
        var updater = System.IO.Path.Combine(AppContext.BaseDirectory, "Update-Frosty.ps1");
        if (!System.IO.File.Exists(updater)) { MessageBox.Show(this, "The updater is missing. Reinstall Frosty using the latest installer.", "Cannot update Frosty", MessageBoxButton.OK, MessageBoxImage.Error); return; }
        try
        {
            var startInfo = new ProcessStartInfo { FileName = "powershell.exe", WorkingDirectory = System.IO.Path.GetTempPath(), UseShellExecute = false, CreateNoWindow = false };
            startInfo.ArgumentList.Add("-NoProfile"); startInfo.ArgumentList.Add("-ExecutionPolicy"); startInfo.ArgumentList.Add("Bypass"); startInfo.ArgumentList.Add("-File"); startInfo.ArgumentList.Add(updater);
            startInfo.ArgumentList.Add("--update"); startInfo.ArgumentList.Add("latest"); startInfo.ArgumentList.Add("-WaitForProcessId"); startInfo.ArgumentList.Add(Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            Process.Start(startInfo); StatusText.Text = "Updater launched. Frosty will close while the latest build is installed."; Close();
        }
        catch (Exception ex) { MessageBox.Show(this, "Could not start the updater: " + ex.Message, "Update failed", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    private void UninstallFrosty_Click(object sender, RoutedEventArgs e)
    {
        var confirmation = MessageBox.Show(
            this,
            "Remove Frosty from this Windows account? The app, command launcher, shortcuts, installer-managed prerequisites (such as Node.js used for tests), and Frosty build artifacts will be removed where possible. Saved .frosty projects, original media, and recovery snapshots will be kept. Pre-existing tools are not removed.",
            "Uninstall Frosty",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning,
            MessageBoxResult.No);
        if (confirmation != MessageBoxResult.Yes) return;

        var uninstallScript = System.IO.Path.Combine(AppContext.BaseDirectory, "Uninstall-Frosty.ps1");
        if (!System.IO.File.Exists(uninstallScript))
        {
            MessageBox.Show(this,
                "The uninstaller is missing from this installation. Reinstall Frosty using the latest installer, then try again.",
                "Cannot uninstall Frosty", MessageBoxButton.OK, MessageBoxImage.Error);
            return;
        }

        if (_dirty)
        {
            CreateRecoverySnapshot();
            var discardConfirmation = MessageBox.Show(
                this,
                "This project has unsaved changes. Frosty attempted to create a recovery snapshot, but the latest changes may not be in your saved .frosty project. Continue uninstalling?",
                "Unsaved project changes",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning,
                MessageBoxResult.No);
            if (discardConfirmation != MessageBoxResult.Yes) return;
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                WorkingDirectory = System.IO.Path.GetTempPath(),
                UseShellExecute = false,
                CreateNoWindow = true
            };
            startInfo.ArgumentList.Add("-NoProfile");
            startInfo.ArgumentList.Add("-ExecutionPolicy");
            startInfo.ArgumentList.Add("Bypass");
            startInfo.ArgumentList.Add("-File");
            startInfo.ArgumentList.Add(uninstallScript);
            startInfo.ArgumentList.Add("-Quiet");
            startInfo.ArgumentList.Add("-WaitForProcessId");
            startInfo.ArgumentList.Add(Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
            _ = Process.Start(startInfo) ?? throw new InvalidOperationException("Windows did not start the uninstaller.");
            _dirty = false;
            StatusText.Text = "Uninstall started. Frosty will now close.";
            Close();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Could not start the uninstaller: " + ex.Message,
                "Uninstall Frosty", MessageBoxButton.OK, MessageBoxImage.Error);
        }
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
    protected override void OnClosed(EventArgs e) { _autosaveTimer.Stop(); StopPreview(); if (_project != IntPtr.Zero) Native.frosty_project_destroy(_project); if(_renderedPreviewPath is not null)try{System.IO.File.Delete(_renderedPreviewPath);}catch{} base.OnClosed(e); }
}

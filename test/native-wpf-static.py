#!/usr/bin/env python3
"""Static WPF integration checks; these are not a substitute for dotnet build on Windows."""
import re
import xml.etree.ElementTree as ET
from pathlib import Path
root=Path(__file__).resolve().parents[1]
xaml=(root/'windows/Frosty.Desktop/MainWindow.xaml').read_text(encoding='utf-8')
cs=(root/'windows/Frosty.Desktop/MainWindow.xaml.cs').read_text(encoding='utf-8')
workflow=(root/'windows/Frosty.Desktop/NativeWorkflow.cs').read_text(encoding='utf-8')
media_paths=(root/'windows/Frosty.Desktop/MediaToolPaths.cs').read_text(encoding='utf-8')
header=(root/'native/include/frosty/c_api.h').read_text(encoding='utf-8')
ET.fromstring(xaml)
events=set(re.findall(r'(?<![A-Za-z0-9_])(?:Click|SelectionChanged|MouseDoubleClick|MouseLeftButtonDown|MouseLeftButtonUp|MouseMove|PreviewKeyDown|MediaOpened|MediaFailed|TextChanged|LostFocus|Checked|Unchecked|SizeChanged)="([A-Za-z0-9_]+)"',xaml))
methods=set(re.findall(r'\b(?:private|public|protected|internal)\s+(?:async\s+)?(?:void|Task|bool|int|string|double|static\s+string|static\s+double|static\s+int|static\s+bool|IntPtr)\s+([A-Za-z0-9_]+)\s*\(',cs))
missing=sorted(events-methods)
assert not missing, f'XAML event handlers without code-behind methods: {missing}'
for symbol in ('frosty_project_set_clip_effect','frosty_project_set_clip_volume','frosty_project_add_asset_w','frosty_project_recovery_snapshot_w','frosty_project_apply_clip_edits_json','frosty_project_timeline_edit'):
    assert symbol in header, f'Missing native C ABI declaration: {symbol}'
    assert symbol in cs, f'Missing WPF P/Invoke: {symbol}'
for feature in ('ExportAsync','AskAiAsync','ProbeHasAudio','Atempo','amix=','overlay=','NormalizeAiOperations', 'frosty_project_apply_clip_edits_json','scale=w=','rotate=a=','MediaToolPaths.Ffmpeg'):
    assert feature in workflow or feature in cs, f'Missing workflow implementation marker: {feature}'
for filename, source in [('MainWindow.xaml.cs',cs),('NativeWorkflow.cs',workflow)]:
    assert source.count('{')==source.count('}'), f'Brace imbalance in {filename}'
for feature in ('NormalizeAiOperations', 'set_transition', 'set_keyframe', 'set_track_state', 'timeline_edit', 'add_clip', 'remove_transition', 'RenderTimelineCanvas','SnapTimelineTime','TimelineCanvas_MouseMove','TimelineCanvas_MouseLeftButtonUp','TimelineSplitAtPlayhead_Click','TimelineInsertGap_Click','TimelineRippleDeleteRange_Click','RippleDeleteSelected_Click','ApplyClipEditOperations','MainWindow_PreviewKeyDown'):
    assert feature in cs or feature in workflow, f'Missing native planner/timeline operation: {feature}'
assert 'SplitClip' in (root/'native/include/frosty/core.hpp').read_text(encoding='utf-8')
assert 'op=="split"' in (root/'native/src/c_api.cpp').read_text(encoding='utf-8')
assert 'Environment.CurrentDirectory' not in media_paths, 'media tool resolution must not execute binaries from an arbitrary working directory'
assert 'FROSTY_FFMPEG' in media_paths and 'AppContext.BaseDirectory' in media_paths, 'media tools resolve from explicit override or trusted app directory'
assert '?? throw new FileNotFoundException' in media_paths, 'missing media tools fail clearly instead of falling back to a bare executable name searched from the current directory'
print(f'WPF static integration checks passed: {len(events)} XAML event handlers, native ABI declarations, visual timeline/edit operations, render/audio/effects/AI workflows, balanced braces.')
print('NOTE: static checks do not prove C# compilation or Windows runtime behavior.')

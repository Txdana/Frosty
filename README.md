# ❄ Frosty

Frosty is an AI-assisted Windows video editor. It uses an original editor implementation informed by feature research into FreeCut, OpenShot, Shotcut/MLT, Kdenlive, libopenshot, `/brag`, and Agent Reach. It does not claim feature parity with those projects yet, and does not bundle their code.

## Native C++ / C# migration (Phase 1 in progress)

The `native/` and `windows/Frosty.Desktop/` folders start a parallel migration to a C++20 timeline/project core with a C ABI and a C# WPF Windows shell. Phase 1 implements the canonical project model, schema-v2 JSON persistence, legacy `.frosty` migration, validation/repair, atomic saves, recovery snapshots, undo/redo snapshots, and core timeline edit commands. The current Electron app remains the default launcher and compatibility reference while later phases migrate preview, FFmpeg rendering, effects, AI and the full editing UI. This is not yet a complete native video-editor replacement.

See [`IMPLEMENTATION_REPORT.md`](IMPLEMENTATION_REPORT.md) for verified test results and outstanding Windows-only validation. Native build instructions are in [`native/README.md`](native/README.md).

## Build and run from source

Requirements: Node.js 20+ (current LTS recommended), npm, Windows x64 for the Windows installer.

```powershell
npm install
npm test
npm start
npm run dist:win
```

`npm run dist:win` builds a Windows NSIS setup executable on the machine doing the build. The setup executable is an output of the local build, not downloaded from GitHub. Frosty's attached blue-violet line-art image is used as the app logo and Windows icon.

## One-command PowerShell installer (`irm`)

The installer downloads **source code**, installs Node.js LTS through `winget` only if needed, runs `npm install` and `npm test`, builds the Windows setup executable locally, then runs that newly built installer. It does not fetch a prebuilt Frosty EXE from GitHub.

After you publish this project to your own public GitHub repository, run in PowerShell:

```powershell
$env:FROSTY_REPO = 'YOUR_GITHUB_NAME/Frosty'; irm https://raw.githubusercontent.com/YOUR_GITHUB_NAME/Frosty/main/installer.ps1 | iex
```

Replace `YOUR_GITHUB_NAME` with the actual repository owner. Or set `$env:FROSTY_SOURCE_URL` to a ZIP containing the Frosty source. The installer intentionally fails clearly while the default `OWNER/Frosty` placeholder is unchanged. Review `installer.ps1` before piping a remote script into `iex`.

## AI configuration

Open Settings and add an OpenRouter API key. Choose a model that supports the modalities/tools needed for your task. AI plans changes; Frosty's local media engine executes them. Network access, model availability, usage costs, and platform restrictions can affect results.

## Current capabilities in this source archive

- Media import, media-bin thumbnails/waveforms, main video track, overlay/PiP layers, audio clips and text overlays
- Trim/move controls, snapping, split/ripple-delete, undo/redo, speed, volume, fades, transitions and common effects
- FFmpeg export presets, silence detection, scene splitting, local Whisper transcription, AI timeline edits and OpenRouter tool-calling loop
- URL media download, web search/read helpers, Doctor diagnostics, AI image generation backend, and `/brag`-style launch-video rendering

## Honest status

The existing self-test exercises the media engine and mocked OpenRouter tool-calling path. It does **not** prove every UI control, live OpenRouter integration, every media codec, all platform downloads, Windows setup behavior, or feature parity with the upstream editors. The installer runs tests before building and stops if tests fail. Validate the actual Windows app after installation and report any failing workflow.

## Licensing

Frosty's current source is marked MIT and is independently implemented. Do not copy or bundle GPL-licensed upstream code unless you deliberately change Frosty's licensing and comply with all obligations. OpenShot's Qt app is GPLv3 according to its repository; FreeCut's repository lists MIT. Review every upstream license before porting code. See the upstream repositories for current terms.


## v0.6.0 — searchable scene library and retrieval-aware AI editing

This increment adds a persistent scene index to the existing Windows Electron editor:

- **Scene indexing:** detects scene boundaries with FFmpeg, extracts a representative thumbnail for each scene, and stores source path plus precise source in/out timestamps.
- **Transcript grounding:** attempts to attach Whisper transcript text to each scene; indexing remains usable if transcription is unavailable.
- **Optional visual captions:** when enabled and an OpenRouter key is configured, the selected editing model receives the representative frame and generates a concise searchable visual description. This makes captioning API-billed and opt-in.
- **Video-RAG-style retrieval:** keyword-ranks scene captions, dialogue, and filenames from a persistent local JSON index. This is a practical first retrieval layer, not a claim of embedding-based vector search.
- **Scene-to-timeline:** search results can be added as source-trimmed clips without re-encoding them first.
- **Agent retrieval tools:** the OpenRouter agent can call `search_scenes` and `add_scene`; it must search the local index and use a returned scene key before adding a scene.
- **Music ducking control:** exposes the existing FFmpeg side-chain compression capability as a “Duck music under dialogue” control.

### Scene library workflow

1. Import the media you want Frosty to search.
2. In **Scene Search (Video-RAG)**, choose **AI visual captions** if desired and if you have configured OpenRouter.
3. Click **Index media** and wait for the status indicator to finish.
4. Search for a phrase, object, action, or words from dialogue.
5. Click **Add scene** to place the exact source segment on the main timeline. The AI editor can also search and add indexed scenes through its tools.

The index is stored under Frosty's Electron user-data directory as `scene-index.json`; representative JPEGs are stored in its `scene-frames` cache. Re-indexing skips scene records already present in the index. If a source file is moved or renamed, re-import it from its current path and re-index it.

### Verification status

JavaScript syntax checks passed for the modified main, preload, renderer, AI and index modules. The standalone scene-index ranking/persistence check passed. The full `npm test` suite could not run in this environment because the package dependency `ffmpeg-static` was not installed; an install attempt timed out. The actual Electron window, OpenRouter visual captioning, Whisper, FFmpeg indexing, and Windows installer still require validation on a Windows machine with dependencies installed.

### Important scope boundary

Frosty is not yet feature-parity complete with the combined feature inventory in `FEATURE_INTEGRATION.md`. In particular, the full keyframe graph editor, nested sequences, comprehensive colour scopes, advanced ripple/roll/slip/slide tools, robust proxy/relink workflow, semantic vector embeddings, spatio-temporal knowledge graphs, and end-to-end Windows installer testing remain separate implementation work. This release adds a functional first scene-retrieval path and exposes an existing audio-ducking engine feature; it does not pretend the entire long roadmap is complete.

## v0.7.0 — transform controls and keyframe foundation

This increment adds a transform object to main-track clips, transform controls in the Inspector, frame-step buttons, and keyframe data persisted with the `.frosty` project JSON. The Inspector can add linear, constant, or smoothstep/Bézier-style keyframes for position, scale, rotation, opacity, shear, volume, and speed. The preview evaluates supported keyframes while scrubbing and playback. The FFmpeg export applies static clip scale, rotation, shear and position, and evaluates scale/rotation keyframes during rendering.

Important limits: this is **not** a full graph editor/dopesheet. Main-track position keyframes and opacity keyframes are preview-only at present; opacity is not yet composited against lower tracks during export. The main timeline is still not a full arbitrary multi-track sequence editor. Nested sequences, true roll/slip/slide/rate-stretch tools, full masks/corner-pin, broad transitions/effects, colour scopes, capture, local TTS/music generation, HDR/spatial audio, broad codec and hardware-acceleration parity remain outstanding. These are explicitly not claimed as completed.

### Verification for v0.7.0

- JavaScript syntax checks passed for the edited modules.
- `FROSTY_FFMPEG=/usr/bin/ffmpeg npm test` passed in the Linux build environment, including a real FFmpeg export with static shear/rotation/scale and keyframed rotation/position data present in the project. This is an engine test using the system FFmpeg, not a Windows installer or Electron GUI test.
- Windows installer creation, Electron UI interaction, OpenRouter, Whisper, device-specific codecs and GPU/hardware acceleration still need verification on Windows.


## v0.8.0 — stacked video tracks

This increment promotes overlay clips into explicit video-track rows. Use **+ Video track** to add a row, click a row's **Vn · Target** control, then use **PiP** on a media-bin item to place that media on the selected row at the playhead. Clips on each row can be moved and trimmed independently, overlap in time, and are composited in track order during export (higher-numbered tracks render above lower-numbered tracks). Existing projects migrate in memory: legacy overlay layers become track V2, and the existing sequential main-video track remains intact.

This is a practical stacked-track foundation, not full NLE parity: the main video row is still a sequential montage, while additional rows are composited overlay tracks. Track mute/visibility/lock, drag-reordering track rows, true insert/ripple editing across every track, nested sequences, and audio automation remain outstanding. Animated position and main-track alpha still do not have full export compositing support.

### Verification for v0.8.0

- `FROSTY_FFMPEG=/usr/bin/ffmpeg npm test` passed, including a real export containing multiple overlay track levels.
- Syntax checks passed for the changed timeline model, FFmpeg exporter, AI agent, renderer, and smoke tests.
- The Electron GUI and Windows installer still need validation on Windows.


## v0.9.0 — Track controls and cross-track ripple editing

- Added persistent per-video-track state: display name, visibility, mute, and lock flags. Legacy projects are upgraded in memory by `TL.ensure`.
- Added UI controls for track visibility, mute, lock, and deleting an overlay track. Track deletion removes assigned overlay clips and renumbers higher tracks. The main track has visibility/mute/lock controls too.
- Export respects hidden overlay tracks, hidden main-video output (black background), and muted main/overlay track audio.
- Added a cross-track ripple-delete timeline-model operation that adjusts overlay, audio, and text timing when an interval is removed.
- Added smoke coverage for track state, track deletion, and ripple timing.

Known limitations remain: the main montage is still sequential rather than a fully free-positioned clip lane; lock controls currently protect direct overlay dragging/trimming and main-track trimming but are not a complete permission system; ripple editing is an engine operation and does not yet have a dedicated range-selection UI; track state currently applies to video/overlay tracks rather than independent named audio buses.

## v1.0.0 — editorial trim operations

- Added model-level roll, slip, slide and rate-stretch operations with bounds checks and duration preservation rules.
- Added splitting overlay clips at a timeline time and reordering overlay video tracks while preserving track metadata.
- Exposed the operations through the AI `apply_ops` tool schema.
- Added track rename and up/down reorder controls to the overlay-track UI.
- Added regression checks for each operation.

These are working editing-engine operations; they are not yet a full mouse-driven professional trim interface. Roll/slide currently operate on the sequential main montage's neighbouring clips, and do not replace a free-positioned multitrack timeline. Source duration should be supplied for exact slip bounds when known.


## v1.1.0 — animated overlays, audio automation, and safer ripple delete

- Overlay animation keyframes now include X/Y position, size, opacity, rotation, and volume. The Inspector exposes keyframe insertion controls and the preview evaluates these values while scrubbing and playback runs.
- FFmpeg export evaluates overlay position, size, opacity, rotation, and overlay-audio volume automation. Main-clip and standalone audio volume keyframes are also passed to FFmpeg's frame-evaluated volume filter.
- Cross-track ripple delete now splits overlay/audio clips that span the removed interval, preserves both surviving source ranges, shifts right-hand pieces to the cut point, and splits text overlays that span the cut.
- Regression coverage includes a real FFmpeg export with animated overlays and audio automation, plus source-continuity checks for ripple deletion.

Known limits: the base video track remains a sequential montage rather than a freely positioned clip lane; animated main-track position and alpha are not yet composited over lower tracks; Bézier interpolation is smoothstep rather than editable cubic handles; the timeline still lacks a dedicated range-selection ripple UI and mouse-driven roll/slip/slide trim modes. Full professional-editor parity and Windows installer/UI validation are not claimed.


## v1.2.0 — Free timeline mode

- Added a backward-compatible `sequential` / `free` timeline mode. Existing projects stay sequential unless explicitly switched.
- In free mode, main video clips have absolute timeline starts, can overlap, and can be assigned to V1 or any added video track. The timeline UI supports dragging clips horizontally and editing their start time/track in the Inspector.
- Preview can display multiple active main-track clips simultaneously, including per-clip transforms and opacity animation.
- FFmpeg has a separate compositing export path that composites main clips and overlay layers in track order, while respecting per-track visibility/mute state, plus text and background music.
- Free-mode ripple deletion preserves the surviving source portions of clips and shifts later material.
- AI operations include `set_timeline_mode` and `move_clip_to_time`.

This is the first free-positioned main-track implementation, not full NLE parity. Track reassignment for main clips, linked A/V editing, all transition types in free mode, and a fully asynchronous multi-video preview pipeline remain future work.

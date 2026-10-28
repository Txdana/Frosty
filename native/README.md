# Frosty Native Engine and WPF Workspace

The native project model is owned by a C++20 shared library (`src/core.cpp`) and exposed to the WPF desktop through `include/frosty/c_api.h`. The WPF workspace now includes project persistence/recovery, media import and source preview, track/clip edits, per-clip effect controls, per-clip volume controls, an FFmpeg sequence-render preview/export workflow, and an optional OpenRouter AI edit planner with a review-before-apply step.

## Build and test the C++ engine

Requirements: CMake 3.20+, C++20 compiler, and Boost headers (Property Tree is used for JSON parsing).

### Windows

```powershell
cmake -S native -B native/build -A x64
cmake --build native/build --config Release
ctest --test-dir native/build -C Release --output-on-failure
```

### Linux

```bash
cmake -S native -B native/build
cmake --build native/build -j2
ctest --test-dir native/build --output-on-failure
```

## Build the WPF application on Windows

Requires Visual Studio C++ build tools, Boost headers, .NET 8 SDK, FFmpeg and FFprobe on `PATH`.

```powershell
.\scripts\build-native.ps1 -Configuration Release
```

Or build the desktop project after building the native DLL:

```powershell
dotnet build windows/Frosty.Desktop/Frosty.Desktop.csproj -c Release
```

The app expects `frosty_core.dll` beside the published WPF executable. The build script is the preferred path because it builds the native DLL and publishes the WPF application together.

## Current WPF workflow coverage

- Open, save, save-as, validation display, autosave recovery snapshots and startup recovery.
- Import references to video, audio and still-image assets; duration probing uses FFprobe when available.
- Source preview using the Windows media stack; codec support is limited by Windows' installed media components.
- Add video/audio tracks, place clips, move clips, trim source ranges, remove clips, track mute/lock, undo/redo.
- Per-clip brightness, contrast and blur effects, clear-effects operation, and per-clip volume controls. The underlying C++ command history records these changes.
- FFmpeg sequence preview and MP4 export. The export graph composites enabled visible video/image clips in track order, applies supported stored effects, uses opacity, mixes audio streams with clip/track gain and mute/solo state, and offers global brightness/contrast/saturation/blur/master-gain controls. Native Bézier masks create static PNG or streamed lossless FFV1 grayscale mattes and multiply the matte with the clip alpha before compositing. `libx264` is the safe default; NVENC/QSV/AMF can be selected if the matching FFmpeg build and hardware are installed. A separate live preview path continuously decodes active clips and composites them using Direct3D 11.
- Project-aware OpenRouter edit planning with validated operations for creating video/audio tracks, placing existing assets on existing or newly created tracks, moving/trimming/splitting/deleting clips, volume/speed/opacity/enabled/name/transform changes, keyframes, allowlisted effects, rectangle/ellipse/path/Bézier mask persistence, track gain/opacity/mute/solo/visibility/lock/name state, timeline gap/ripple edits, and transition creation/removal. Plans are normalized and validated, shown to the user, and submitted as one native command-history batch; a failed operation rejects the full batch. The planner does not silently skip unsupported operation names. API keys are requested for the session and are not persisted by this feature.

## Explicitly not complete / not yet verified

This is not full parity with the Electron application. The WPF workspace has a visual Canvas timeline, but it still lacks full professional transform/keyframe graph editing, the full Electron effect/filter set, native transcription/scene-search/Reach/Brag panels, AI image/web/media acquisition tools, and every export option. Native AI edit operations are broader but do not implement all Electron agent tools. Interactive Bézier masks are implemented in source, but Windows interaction and preview/export parity remain uncertified without a Windows run. The live Direct3D path still has CPU decode/mask/effect stages and is not an all-GPU pipeline. Some legacy fields remain preserved without being editable/renderable natively.

The current CI/container environment used for source work has no .NET SDK or Windows media stack, so a successful WPF compile, launch, Windows installer build, hardware encoder run and real Windows project round-trip must still be performed on Windows. C++ CTest and the Electron regression suite do not prove those Windows-specific paths. For mask parity, verify the same keyed mask visually in the live preview and rendered export, including an image with existing transparency, feathering, inversion, and at least two animated poses.

# Frosty Native Engine (Phase 1)

This directory begins the migration from the existing Electron implementation to a native Windows desktop architecture:

- **C++20 shared library** (`src/core.cpp`) owns project/timeline state, validation, migration, commands, history, and persistence.
- **C ABI** (`include/frosty/c_api.h`) is the stable boundary for the C# desktop application.
- **C# WPF shell** lives in `../windows/Frosty.Desktop/` and calls the native project APIs.
- **FFmpeg integration is intentionally a later phase**. This milestone does not claim to provide playback, timeline rendering, decoding, or export parity yet.

## Build the native engine

Requirements: CMake 3.20+, a C++20 compiler, and Boost headers (Property Tree is used for JSON parsing).

### Windows (Visual Studio Build Tools)

```powershell
cmake -S native -B native/build -A x64
cmake --build native/build --config Release
ctest --test-dir native/build -C Release --output-on-failure
```

### Linux smoke-test build

```bash
cmake -S native -B native/build
cmake --build native/build -j2
ctest --test-dir native/build --output-on-failure
```

## Build the WPF shell on Windows

Run the provided PowerShell build script from the repository root (requires CMake, Visual Studio C++ build tools, Boost headers, and .NET 8 SDK):

```powershell
.\scripts\build-native.ps1 -Configuration Release
```

It configures/builds the C++ engine, runs CTest, publishes the WPF workspace, and places the matching native DLL beside the executable. To build only the WPF project manually after building C++, run:

```powershell
dotnet build windows/Frosty.Desktop/Frosty.Desktop.csproj -c Release
```

The desktop project expects `frosty_core.dll` to be in one of the native CMake build output locations referenced by the project file. Copy the Release DLL beside the WPF executable if your generator uses a different output layout.

## Phase 1 scope

- Versioned `.frosty` JSON project schema (`schemaVersion: 2`).
- Legacy sequential/free-timeline project migration into sequences, tracks, assets, and positioned clips; original source fields are retained in `legacyPayload` / `legacyFields` for future migration work.
- Unique IDs for projects, sequences, tracks, clips, assets, markers, keyframes, effects, groups, and transitions.
- Sequence and project settings (rational frame rate, resolution, pixel aspect, color metadata, audio layout, export defaults).
- Track state and linked/grouped/nested clip references; group and transition records are persisted and validated.
- Validation and conservative repair of IDs, source ranges, track/asset references, settings, linked references, and nested-sequence cycles.
- Temporary-file writes and atomic replacement with rollback fallback. The exact original source JSON is retained in `legacySourceJson` so unknown fields and their original scalar text are not silently discarded during migration.
- Bounded recovery snapshots and whole-project undo/redo snapshots. The WPF shell schedules recovery snapshots every 60 seconds when dirty and offers startup recovery.
- Shared validated command layer for timeline edits, clip movement/range changes, track creation/state, and clip removal.
- Ripple-delete, insert-gap, and overwrite-range behavior with locked-track protection.

The WPF shell is an early project-management workspace, not a finished video editor. The current UI can open/save projects, display model tracks, add video/audio tracks, toggle track lock/mute, and undo/redo those track changes. **Full code migration is not complete:** media import/probing, clip editing UI, preview playback, FFmpeg render graph/export, effects, AI, scene search, and Windows release packaging still need migration. Keep the existing Electron editor as the compatibility reference until native feature parity is built and tested.

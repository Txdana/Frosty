# Frosty

Frosty is an AI-assisted Windows video editor with a native C++20 timeline/project core, a C# WPF desktop application, media analysis, and FFmpeg-based rendering. A legacy Electron editor remains in the repository for development and compatibility, but the one-command installer builds the native Windows application. The native app is still in development and does not yet match every capability of the Electron implementation or a mature professional NLE.

- **Repository:** <https://github.com/Txdana/Frosty>
- **Platform:** Windows 10/11, x64
- **License:** Apache-2.0 for original Frosty code and documentation; third-party components retain their own licenses

## Install from PowerShell

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/Txdana/Frosty/master/installer.ps1 | iex
```

The installer downloads the source over HTTPS, verifies that it is a Frosty project, installs missing build tools with WinGet and vcpkg, checks FFmpeg, runs regression tests, builds the native C++ engine and self-contained WPF app, installs it under `%LOCALAPPDATA%\Programs\Frosty`, creates Start Menu and Desktop shortcuts, and launches the app. It does not download an unverified prebuilt Frosty executable or bundle FFmpeg inside Frosty.

**The repository must be public for this anonymous command to work.** Private repositories cannot serve the script and source archive to unauthenticated users. Review `installer.ps1` before running a remote script with `iex`. A fresh setup can download several gigabytes, and Visual Studio Build Tools may request elevation or a restart. WinGet/App Installer and an internet connection are required.

## Update Frosty

In the app, click **Check for updates** in the top bar. From a terminal, run:

```powershell
frosty --update latest
```

The command downloads the current `master` source installer, reruns regression tests, rebuilds the native C++/WPF application, stages the new build, and replaces the installed app. It may take several minutes and needs internet access and the Windows build prerequisites.

## Uninstall Frosty

Click **Uninstall** in the native app's top bar, or uninstall **Frosty** from **Windows Settings → Apps → Installed apps**.

From PowerShell, run:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\Frosty\Uninstall-Frosty.ps1"

You can also launch `%LOCALAPPDATA%\Programs\Frosty\Uninstall-Frosty.cmd` from File Explorer or a terminal. The uninstaller removes Frosty's installed application files, command shim, shortcuts, Windows uninstall registration, private vcpkg/Boost toolchain and source snapshot. It attempts to uninstall WinGet prerequisites recorded as newly installed by Frosty's installer (for example Node.js, CMake, .NET SDK, Python, and FFmpeg). Pre-existing tools are not removed; failed package removals are reported for manual cleanup. Saved `.frosty` projects, original media, and recovery snapshots are preserved. The app asks about unsaved edits and attempts a recovery snapshot before proceeding.

### Prerequisites

The installer checks for and installs missing components:

- Node.js LTS 20 or newer, for project tests and development tooling
- CMake 3.20 or newer
- Visual Studio 2022 Build Tools with the C++ workload and Windows SDK
- .NET 8 SDK for publishing the native application (the published application is self-contained)
- Python 3 for integration/static checks
- Microsoft vcpkg and Boost.PropertyTree headers
- FFmpeg as a separate installation, only after displaying its separate license information and asking permission

Correctly installed prerequisites are reused. If WinGet is unavailable, install or update **App Installer** from the Microsoft Store and rerun the command.

## Build from source

On Windows x64, install the prerequisites above and run from the repository root:

```powershell
npm ci
npm test
.\scripts\build-native.ps1 -Configuration Release -Runtime win-x64
```

The native published files are written to `dist/native-windows`. To run the older Electron compatibility UI while developing, use `npm start` after `npm ci`. The Electron and native implementations are not at full feature parity. The primary native build command is `npm run dist:win`; it checks FFmpeg, runs tests, compiles the C++ core and publishes a native distribution ZIP.

## FFmpeg and third-party licensing

Frosty does not ship `ffmpeg.exe`, `ffprobe.exe`, or the `ffmpeg-static` npm wrapper. It locates a separately installed FFmpeg using `PATH` or `FROSTY_FFMPEG`; `FROSTY_FFPROBE` can be used to select a specific FFprobe executable. If FFmpeg is absent, the installer offers the `Gyan.FFmpeg` WinGet package. Its manifest declares **GPL-3.0**. This is a separate third-party installation and is not covered by Frosty's Apache-2.0 license. You can decline and install another compatible build. FFmpeg's applicable license depends on the exact build configuration and enabled components; see <https://ffmpeg.org/legal.html>.

Read [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), [`RUNTIME_REQUIREMENTS.md`](RUNTIME_REQUIREMENTS.md), and [`docs/REFERENCE_INTEGRATION_ATTRIBUTION.md`](docs/REFERENCE_INTEGRATION_ATTRIBUTION.md) before redistributing builds.

## AI features

AI features require a supported provider/model and may require an API key, internet access, and paid usage. Review proposed edits before applying them, and only use media you have permission to process or recreate. Outputs are limited to functions implemented in the current application.

## Status and limitations

Frosty is under active development. The native WPF application has project persistence and recovery, timeline editing, media import/source preview, effects and volume controls, an FFmpeg sequence-render preview/export path, optional AI edit planning, and GPU preview integration. Feature coverage varies by workflow; this is not a claim of complete professional-editor parity. Actual Windows compilation, GUI interaction, codec coverage, hardware-specific preview and export behavior must be validated on Windows. See [`native/README.md`](native/README.md) for native build instructions and known limitations.

## License

Frosty's original source code and documentation are licensed under the [Apache License 2.0](LICENSE), unless a specific file or notice says otherwise. See [`NOTICE`](NOTICE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Apache-2.0 does not change the licenses of separately installed dependencies, upstream components, fonts, media or other third-party assets.

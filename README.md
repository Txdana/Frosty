# Frosty

Frosty is an AI-assisted Windows video editor with media analysis, timeline/project editing, and FFmpeg-based rendering. The repository contains a legacy Electron editing UI and an early native C++20 / C# WPF migration. The native application is the default installation path, but it is not yet at full feature parity with the Electron editor or a replacement for every professional NLE workflow.

- **Repository:** https://github.com/Txdana/Frosty
- **Platform:** Windows 10/11, x64
- **License:** Apache-2.0 for original Frosty work; third-party components retain their own licenses

## Install with one PowerShell command

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/Txdana/Frosty/master/installer.ps1 | iex
```

The bootstrap downloads the source ZIP over HTTPS, checks the source layout, installs missing build prerequisites with WinGet and vcpkg, verifies FFmpeg, runs the project tests, builds the C++ core and self-contained WPF app, installs Frosty under `%LOCALAPPDATA%\Programs\Frosty`, creates shortcuts, and launches the app. It does not download a prebuilt Frosty executable from an unrelated mirror, does not bundle FFmpeg, and does not silently fall back to Electron.

**Repository visibility matters:** the repository must be public for this anonymous `irm` command to download the script and source ZIP. Private GitHub repositories cannot be fetched by anonymous PowerShell requests. Review `installer.ps1` before piping a remote script into `iex`. The setup can download several gigabytes; Visual Studio Build Tools may request elevation or a restart.

### Prerequisites installed automatically

The installer checks for and installs missing components:

- Node.js LTS 20 or newer
- CMake 3.20 or newer
- Visual Studio 2022 Build Tools, the C++ workload, and a Windows SDK
- .NET 8 SDK (build-time only; the published app is self-contained)
- Python 3 for the integration/static checks
- Microsoft vcpkg and Boost.PropertyTree headers for the native core
- FFmpeg, only after showing its package/license information and asking permission

WinGet/App Installer and an internet connection are required. If WinGet is unavailable, install or update App Installer from the Microsoft Store and rerun the same command. Correctly installed prerequisites are reused.

## Build and run from source

On Windows x64, install the prerequisites listed above or run the one-command installer first. From a source checkout:

```powershell
npm ci
npm test
.\scripts\build-native.ps1 -Configuration Release -Runtime win-x64
```

The native publish output is written to `dist/native-windows`. The WPF app is self-contained for .NET, but FFmpeg remains a separate executable. To run the legacy Electron compatibility UI during development, use `npm start` after `npm ci`. The native and Electron implementations are not at full feature parity.

## FFmpeg and third-party licensing

Frosty does not ship `ffmpeg.exe`, `ffprobe.exe`, or the GPL-licensed `ffmpeg-static` npm wrapper. It locates a separately installed FFmpeg through `PATH` or the `FROSTY_FFMPEG` environment variable. If FFmpeg is missing, setup offers the `Gyan.FFmpeg` WinGet package; its WinGet manifest declares GPL-3.0. This is a separate third-party installation, not part of Frosty's Apache-2.0 code. You may decline and install a compatible build yourself. FFmpeg's applicable license can depend on the exact build configuration and enabled components; see https://ffmpeg.org/legal.html.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [RUNTIME_REQUIREMENTS.md](RUNTIME_REQUIREMENTS.md) before redistributing a release. Research notes describe scope and limitations; upstream projects are references, not a declaration that their source code is bundled.

## AI configuration

AI-assisted tasks require a supported model/provider and may require an API key, network access, and paid usage. Review proposed edits before applying them, and only use media you have permission to process or recreate. Results are limited to functionality currently exposed by the application.

## Status and limitations

Frosty is under active development. The native WPF application currently focuses on the project/timeline core and migration work; it is not yet a complete professional-editor replacement. Test the actual Windows GUI, codecs, export paths, and hardware-specific behavior on the target PC. See [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) and [native/README.md](native/README.md) for implementation notes and limitations.

## License

Original Frosty source code and documentation are licensed under the [Apache License 2.0](LICENSE), unless a file or third-party notice says otherwise. See [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Apache-2.0 does not change the licenses of separately installed dependencies, upstream code, fonts, media, or other third-party assets.

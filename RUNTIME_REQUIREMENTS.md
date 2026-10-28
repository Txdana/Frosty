# Frosty runtime requirements

## Native Windows installation

The one-command installer builds and installs Frosty's native C++/WPF application for Windows x64. The build machine needs Node.js 20+, CMake 3.20+, Visual Studio 2022 C++ Build Tools and a Windows SDK, .NET 8 SDK, Python 3 for tests, and Boost.PropertyTree headers (installed with vcpkg). The published WPF app is self-contained for .NET, so the .NET SDK is not required on the target PC.

FFmpeg/FFprobe are separate command-line programs and are not bundled. The installer checks for a working FFmpeg executable and offers the Gyan.FFmpeg WinGet package after showing its separate GPL-3.0 package license. Internet access and WinGet/App Installer are required for automatic setup. If declined, install a compatible FFmpeg build and make it available on PATH, or set FROSTY_FFMPEG to its executable path.

## Manual FFmpeg configuration

1. Install an FFmpeg build from a source you trust; providers are listed at https://ffmpeg.org/download.html.
2. Add the folder containing ffmpeg.exe to PATH.
3. Open a new terminal and run ffmpeg -version.
4. For a non-standard path, set FROSTY_FFMPEG to the full executable path.

Some FFmpeg builds exclude GPL-only encoders. Codec availability depends on the exact build. Frosty does not relicense FFmpeg under Apache-2.0; see THIRD_PARTY_NOTICES.md.

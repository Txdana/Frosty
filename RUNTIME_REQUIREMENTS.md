# Frosty runtime requirements

Frosty 1.3.0 does not bundle FFmpeg or FFprobe. Frosty launches these as separate command-line programs. Its Windows installers can offer to install FFmpeg through WinGet after showing the user the package identity and license.

## Automatic Windows setup

On a fresh install, Frosty checks for a working FFmpeg executable. If none is found, its setup can offer to install `Gyan.FFmpeg` with Windows Package Manager (WinGet). The current WinGet manifest identifies this package as **GPL-3.0**. This is a separate third-party installation; it is not copied into Frosty's application files, and Frosty's original code remains licensed under Apache-2.0. Automatic installation requires WinGet/App Installer and internet access. If you decline or it fails, Frosty can still be installed, but video probing, preview/export, and other FFmpeg-backed media operations may not work until FFmpeg is configured.

For the native release ZIP, extract the archive and double-click `Install-Frosty.cmd` (or run `Install-Frosty.ps1` from PowerShell); this checks FFmpeg, offers the WinGet install, copies Frosty to `%LOCALAPPDATA%\Programs\Frosty`, creates shortcuts, and launches the app. The source-build bootstrap `installer.ps1` offers the same FFmpeg setup when it has checked out the project. The Electron/NSIS package uses its first-install hook and does not re-prompt during upgrades.

## Manual or custom FFmpeg setup

1. Install an FFmpeg build from a source you trust. The upstream FFmpeg download page lists Windows build providers: https://ffmpeg.org/download.html.
2. Add the directory containing `ffmpeg.exe` to the Windows `PATH`. If `ffprobe.exe` is included in that same build, Frosty will use it when available. WinGet's Gyan package usually exposes portable commands in `%LOCALAPPDATA%\Microsoft\WinGet\Links`.
3. Open a new terminal and run `ffmpeg -version` to confirm Windows can find the executable.
4. For a non-standard path, set `FROSTY_FFMPEG` to the full path of `ffmpeg.exe` and optionally `FROSTY_FFPROBE` to `ffprobe.exe` as persistent user environment variables.

Choose a build with the codecs you need. Some FFmpeg builds exclude GPL-only encoders such as `libx264` and `libx265`; available codecs depend on the build configuration. FFmpeg's own licensing overview explains that its license may be LGPL or GPL depending on enabled components: https://ffmpeg.org/legal.html. Frosty does not relicense FFmpeg under Apache-2.0. See `THIRD_PARTY_NOTICES.md`.

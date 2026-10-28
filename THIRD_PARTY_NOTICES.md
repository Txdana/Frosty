# Third-party notices and release licensing boundary

Frosty's original source code, documentation, and project assets created for Frosty are licensed under Apache-2.0 unless a file or third-party notice says otherwise. This license does not relicense third-party software.

## FFmpeg / FFprobe are external prerequisites (not bundled)

Frosty invokes FFmpeg and, when available, FFprobe as separate command-line programs. The Frosty source tree and release archives do **not** include the `ffmpeg-static` npm package, its GPL-3.0-or-later JavaScript wrapper, or an FFmpeg/FFprobe executable. The package installer scripts can invoke WinGet to install FFmpeg as a separate third-party package after explicit user consent; the FFmpeg binary is downloaded by WinGet from its configured package source, not embedded inside the Frosty release artifact.

The default automatic option is `Gyan.FFmpeg`. Its current WinGet manifest declares **GPL-3.0** and describes a static full build from Gyan. Users can decline this option and configure a different FFmpeg build. FFmpeg itself may be LGPL-2.1-or-later or GPL depending on enabled components; build configurations differ. FFmpeg is not licensed under Apache-2.0 and is not relicensed under that license by Frosty. If you independently redistribute an FFmpeg binary, review that exact build's license, configure flags, linked libraries, and corresponding source obligations.

Upstream references:

- FFmpeg legal considerations and the upstream compliance checklist: https://ffmpeg.org/legal.html
- FFmpeg source license file: https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md
- `ffmpeg-static` npm package license (GPL-3.0-or-later); intentionally not used or shipped by Frosty: https://www.npmjs.com/package/ffmpeg-static
- BtbN Windows FFmpeg builds document their `gpl` and `lgpl` variants; the LGPL variant excludes GPL-only libraries such as libx264 and libx265: https://github.com/BtbN/FFmpeg-Builds
- WinGet package manifest for `Gyan.FFmpeg` (license declared as GPL-3.0; package installer source and current versions): https://github.com/microsoft/winget-pkgs/tree/master/manifests/g/Gyan/FFmpeg
- FFmpeg download page and third-party build references: https://ffmpeg.org/download.html

Fresh Windows installers request explicit user consent before invoking WinGet. The chosen FFmpeg executable remains outside Frosty's application files and is not relabeled under Apache-2.0. Users can decline, install a different FFmpeg build manually, or configure an existing copy. The exact binary's build flags and linked libraries remain controlled by its upstream publisher and should be reviewed if you redistribute FFmpeg yourself.

## Other dependencies

`package.json` and `package-lock.json` identify the project's JavaScript dependencies. Electron and electron-builder remain development dependencies for the optional legacy Electron package path. Review exact contents of any release artifact and preserve third-party license texts and notices required for the versions actually shipped. This file is not a generated, exhaustive inventory of every transitive development dependency and does not replace release-specific compliance review.

## Reference repositories

Frosty's reference research is documented in [`docs/REFERENCE_INTEGRATION_ATTRIBUTION.md`](docs/REFERENCE_INTEGRATION_ATTRIBUTION.md). Those references describe research and inspiration; they are not a declaration that the cited repositories' implementation code or assets are bundled into Frosty.

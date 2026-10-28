# Third-party notices and licensing boundaries

Frosty's original source code and documentation are licensed under Apache-2.0 unless a file or notice states otherwise. This license does not relicense third-party software or assets.

## FFmpeg and FFprobe are external prerequisites

Frosty locates FFmpeg as a separate command-line executable. Frosty does not bundle an FFmpeg or FFprobe binary and does not use or ship the GPL-3.0-or-later ffmpeg-static npm wrapper.

On a fresh Windows setup, the installer can offer to install Gyan.FFmpeg via WinGet after explaining the license and asking the user. The WinGet manifest declares this package GPL-3.0. Users may decline and install another compatible FFmpeg build. FFmpeg's own license can be LGPL or GPL depending on its source version, configuration flags, enabled components, and linked libraries. Verify the exact build if you redistribute it.

References:
- FFmpeg legal overview: https://ffmpeg.org/legal.html
- FFmpeg source license: https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md
- WinGet package manifest: https://github.com/microsoft/winget-pkgs/tree/master/manifests/g/Gyan/FFmpeg
- FFmpeg download page: https://ffmpeg.org/download.html
- Microsoft vcpkg: https://github.com/microsoft/vcpkg

## Other dependencies

The optional Electron development/build path uses Electron and electron-builder, listed in package.json and package-lock.json. Their licensing remains separate from Frosty's Apache-2.0 license. Every redistributable build should be audited for the exact software and assets included, and any required third-party license texts or notices should be shipped.

Upstream repositories examined for workflow concepts are research references, not a statement that their code or assets are bundled. Review IMPLEMENTATION_REPORT.md and file-level notices before redistributing derived work.

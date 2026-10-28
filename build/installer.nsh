; Frosty Electron/NSIS first-install hook.
; FFmpeg remains a separate third-party executable; never bundle it in the app.
; Electron-builder invokes customInstall on install. Skip the prompt on upgrades.

!macro customInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Frosty uses FFmpeg as an external prerequisite. The optional Gyan.FFmpeg WinGet package declares GPL-3.0. Install it now?" IDYES frostyInstallFfmpeg IDNO frostySkipFfmpeg

    frostyInstallFfmpeg:
      DetailPrint "Installing separate FFmpeg prerequisite through WinGet..."
      nsExec::ExecToLog '"powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\scripts\install-ffmpeg.ps1" -InstallIfMissing'
      Pop $0
      ${if} $0 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "FFmpeg installation did not complete successfully. Frosty will still be installed, but media features may be unavailable until a compatible FFmpeg build is installed."
      ${endIf}
      Goto frostyFfmpegDone

    frostySkipFfmpeg:
      DetailPrint "User skipped the optional external FFmpeg installation."

    frostyFfmpegDone:
  ${endIf}
!macroend

; Adds a checkbox to the installer's finish page asking whether JARVIS should
; start automatically with Windows. Reuses NSIS MUI2's "show readme" finish-page
; checkbox slot to run our own function instead of opening a file — the standard
; trick for adding a custom action checkbox to the finish page.
;
; Defining `customFinishPage` replaces electron-builder's default finish-page
; handling entirely (see node_modules/app-builder-lib/templates/nsis/assistedInstaller.nsh)
; rather than extending it, so this macro also re-declares the normal "run after
; install" behavior and calls MUI_PAGE_FINISH itself.
;
; The registry write below targets the same HKCU Run key that Electron's
; app.setLoginItemSettings uses (see src/main/autostart.ts), so this stays in sync
; with the in-app Settings toggle no matter which one the user changes later.
; --hidden tells the app to start tray-only, without opening a window.

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Do you want JARVIS to start automatically with Windows?"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION JarvisEnableAutostart
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

  !insertmacro MUI_PAGE_FINISH
!macroend

; Guarded the same way assistedInstaller.nsh guards its own page-definition code:
; without this, the function is also emitted (unconditionally) during the
; uninstaller compilation pass, where nothing calls it — NSIS then reports it as
; dead code and electron-builder's build fails (warnings are treated as errors).
!ifndef BUILD_UNINSTALLER
  Function JarvisEnableAutostart
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "JARVIS" '"$INSTDIR\JARVIS.exe" --hidden'
  FunctionEnd
!endif

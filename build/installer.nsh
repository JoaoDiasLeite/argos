; Custom NSIS steps, included by electron-builder (package.json build.nsis.include).
;
; customUnInstall removes what the app registers in HKCU at runtime, which the stock
; uninstaller does not know about. Each key or value mirrors the code that writes it.
; User data (settings, sessions in %APPDATA%\Argos) is left alone, as before.

!macro customUnInstall
  ; An auto-update runs the old uninstaller with --updated before installing the new
  ; version. Keep everything then: the protocol and menu are rewritten on the next
  ; launch, but nothing would bring back a removed login item until the user toggles it.
  ${ifNot} ${isUpdated}
    ; Explorer "Open with Argos" entries: MENU_KEYS in src/main/explorer-menu-reg.ts.
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Argos"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Argos"

    ; Start at login: app.setLoginItemSettings (src/main/linux-desktop.ts setOpenAtLogin)
    ; names its Run value after the AppUserModelId, set to com.argos.app in
    ; src/main/index.ts before the call. Electron may also write a StartupApproved value
    ; of the same name; it deletes both when the setting is turned off, so do the same.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.argos.app"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.argos.app"

    ; argos:// handler: app.setAsDefaultProtocolClient('argos') in src/main/index.ts writes
    ; HKCU\Software\Classes\argos with the command "<exe>" "%1". Like Electron's own
    ; removeAsDefaultProtocolClient, only delete it while it still points at this
    ; install's exe, so another app that took the scheme over keeps it.
    ReadRegStr $R0 HKCU "Software\Classes\argos\shell\open\command" ""
    StrCpy $R1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    StrLen $R2 $R1
    StrCpy $R0 $R0 $R2 ; keep only the quoted exe prefix of the command
    ${if} $R0 == $R1 ; LogicLib == is case-insensitive, like Windows paths
      DeleteRegKey HKCU "Software\Classes\argos"
    ${endIf}
  ${endIf}
!macroend

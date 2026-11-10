; The bundled sidecar owns the browsers, so the app always stops it before an
; update installs. A crash, a forced close, or an interrupted shutdown can still
; leave one running, and the default template only closes the main executable.
; Installing over a running sidecar fails with "Error opening file for writing",
; so stop it here. Cloud sessions survive: every open browser's session is saved
; again from its encrypted local queue after the next start.
; An AI client keeps aliasmode-mcp.exe open in the same way. Stopping it also
; stops its MCP helper, an aliasmode-sidecar.exe process. Stop it first and
; without /T: the helper may have started AliasMode, which is not its to stop.
!macro NSIS_HOOK_PREINSTALL
  Push $R0

  nsExec::Exec 'taskkill /F /IM "aliasmode-mcp.exe"'
  Pop $R0
  nsExec::Exec 'taskkill /IM "aliasmode-sidecar.exe"'
  Pop $R0
  Sleep 5000
  nsExec::Exec 'taskkill /F /T /IM "aliasmode-sidecar.exe"'
  Pop $R0
  Sleep 2000

  ; Python scripts now download their runtime into the app data folder. Remove the copy
  ; that earlier versions installed with the app; nothing installs or uninstalls it now.
  RMDir /r "$INSTDIR\playwright\python"

  Pop $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Register as a candidate. Windows owns the user's actual default choice.
  WriteRegStr HKCU "Software\Classes\AliasMode.Url" "" "AliasMode web link"
  WriteRegStr HKCU "Software\Classes\AliasMode.Url" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\AliasMode.Url\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\AliasMode.Url\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\AliasMode" "" "AliasMode"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\AliasMode\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\AliasMode\Capabilities" "ApplicationName" "AliasMode"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\AliasMode\Capabilities" "ApplicationDescription" "Choose a browser or local profile for web links"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\AliasMode\Capabilities\URLAssociations" "http" "AliasMode.Url"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\AliasMode\Capabilities\URLAssociations" "https" "AliasMode.Url"
  WriteRegStr HKCU "Software\RegisteredApplications" "AliasMode" "Software\Clients\StartMenuInternet\AliasMode\Capabilities"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; Earlier versions bundled CloakBrowser here. The app now downloads it into
  ; its data folder, so remove the old copy once the new files are in place. Files that
  ; a still-running browser holds stay until a later update.
  RMDir /r "$INSTDIR\cloakbrowser"

  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4

  ClearErrors
  ${GetOptions} $CMDLINE "/AMATTEMPT=" $R0
  ${IfNot} ${Errors}
    StrLen $R1 $R0
    ${If} $R1 != 32
      Abort
    ${EndIf}

    StrCpy $R2 0
    aliasmode_attempt_character:
      StrCpy $R3 $R0 1 $R2
      ${StrLoc} $R4 "0123456789abcdef" $R3 ">"
      ${If} $R4 == ""
        Abort
      ${EndIf}
      IntOp $R2 $R2 + 1
      IntCmp $R2 32 aliasmode_attempt_valid aliasmode_attempt_character aliasmode_attempt_invalid

    aliasmode_attempt_invalid:
      Abort

    aliasmode_attempt_valid:
      ClearErrors
      FileOpen $R1 "$INSTDIR\.aliasmode-update-$R0.complete" w
      ${If} ${Errors}
        Abort
      ${EndIf}
      FileWrite $R1 "${VERSION}$\r$\n"
      FileClose $R1
      ${If} ${Errors}
        Abort
      ${EndIf}
  ${EndIf}

  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\RegisteredApplications" "AliasMode"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\AliasMode"
  DeleteRegKey HKCU "Software\Classes\AliasMode.Url"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

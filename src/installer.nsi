; Per-user installer + uninstaller. Built by build.mjs, which passes
; -DVERSION -DCOMMIT -DBRANCH -DREMOTE_URL -DSTAGE -DOUTFILE -DLAUNCHER.
; What it relies on from cc (launcher path and exit codes, layout):
; https://github.com/UnmanagedCode/code-conductor/blob/main/docs/windows.md#installer-contract
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\code-conductor"

Name "code-conductor"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\code-conductor"
SetCompressor /SOLID zlib
ShowInstDetails show

!define MUI_FINISHPAGE_RUN "$INSTDIR\code-conductor.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch code-conductor"
!define MUI_FINISHPAGE_TEXT "code-conductor is installed. Your projects live in $PROFILE\code-conductor unless PROJECTS_ROOT is set.$\r$\n$\r$\nIf you have not signed in to Claude yet, run $\"claude auth login$\" once in a terminal."

; Set only once every install step succeeded; the finish page ("installed",
; launch checkbox) is skipped otherwise.
Var InstallOk

!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE"
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE FinishPre
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function FinishPre
  ${If} $InstallOk != 1
    Abort
  ${EndIf}
FunctionEnd

; Appends a line to logs\setup.log (setup.mjs's log) and the details pane,
; so a silent run is auditable. TEXT must not contain a double quote.
!macro SetupLog TEXT
  DetailPrint "${TEXT}"
  CreateDirectory "$INSTDIR\logs"
  ${GetTime} "" "LS" $R0 $R1 $R2 $R3 $R4 $R5 $R6
  FileOpen $R7 "$INSTDIR\logs\setup.log" a
  FileSeek $R7 0 END
  FileWrite $R7 "[$R2-$R1-$R0T$R4:$R5:$R6Z] ${TEXT}$\r$\n"
  FileClose $R7
!macroend

; Whether anything answers 200 on cc's health endpoint (PORT or 8787, as the
; launcher probes it): exit 0 if so. Used only when there is no launcher.
!define HEALTH_PROBE `fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`

; Stops a running server (found through its health endpoint) after asking.
; A server only runs on this install's node, so without node.exe there is
; none. Without the launcher it cannot be stopped here, so a server that
; still answers aborts rather than having node\ or app\ removed under it.
!macro StopRunning PREFIX
  ${If} ${FileExists} "$INSTDIR\node\node.exe"
    ${If} ${FileExists} "$INSTDIR\app\${LAUNCHER}"
      nsExec::ExecToStack '"$INSTDIR\node\node.exe" "$INSTDIR\app\${LAUNCHER}" --status'
      Pop $0
      Pop $1
      !insertmacro SetupLog "installer: launcher --status exited $0: $1"
      ${If} $0 == 0
        MessageBox MB_YESNO|MB_ICONQUESTION "code-conductor is running and must be stopped first. Stop it now?" /SD IDYES IDYES ${PREFIX}stop
        !insertmacro SetupLog "installer: stopping code-conductor was declined"
        Abort
        ${PREFIX}stop:
        nsExec::ExecToStack '"$INSTDIR\node\node.exe" "$INSTDIR\app\${LAUNCHER}" --stop'
        Pop $0
        Pop $1
        !insertmacro SetupLog "installer: launcher --stop exited $0: $1"
        ${If} $0 != 0
          Abort "Could not stop the running code-conductor. See $INSTDIR\logs\setup.log"
        ${EndIf}
      ${ElseIf} $0 == 2
        Abort "A server is answering on the code-conductor port but cannot be identified or stopped automatically. Close it, then run this again."
      ${EndIf}
    ${Else}
      nsExec::ExecToStack `"$INSTDIR\node\node.exe" -e "${HEALTH_PROBE}"`
      Pop $0
      Pop $1
      !insertmacro SetupLog "installer: no app\${LAUNCHER}; health probe exited $0"
      ${If} $0 == 0
        Abort "A code-conductor server is answering, but this install has no app\${LAUNCHER} to stop it with. Close it (or sign out and back in), then run this again."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

Section "Install"
  SetShellVarContext current
  !insertmacro StopRunning "i"

  RMDir /r "$INSTDIR\node"
  SetOutPath "$INSTDIR\node"
  File /r "${STAGE}\node\*.*"

  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${STAGE}\cc.bundle"
  File "${STAGE}\setup.mjs"
  File "${STAGE}\toolchain.mjs"
  File "${STAGE}\pins.json"
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$PLUGINSDIR\setup.mjs" --install-dir "$INSTDIR" --bundle "$PLUGINSDIR\cc.bundle" --branch "${BRANCH}" --remote "${REMOTE_URL}" --launcher "${LAUNCHER}"'
  Pop $0
  ; Nothing below runs on failure: the stub, uninstaller, Uninstall key
  ; (DisplayVersion) and shortcut are written only after setup succeeded.
  ${If} $0 != 0
    Abort "Setup failed (exit $0). See $INSTDIR\logs\setup.log"
  ${EndIf}

  SetOutPath "$INSTDIR"
  File "${STAGE}\code-conductor.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "code-conductor"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}+${COMMIT}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "UnmanagedCode"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\code-conductor.exe"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0

  CreateShortcut "$SMPROGRAMS\code-conductor.lnk" "$INSTDIR\code-conductor.exe"

  ; the user PATH may have changed (claude's dir)
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  StrCpy $InstallOk 1
SectionEnd

; Keeps the projects root and its store, Git, claude and the PATH entry.
Section "Uninstall"
  SetShellVarContext current
  !insertmacro StopRunning "u"
  Delete "$SMPROGRAMS\code-conductor.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DetailPrint "Kept: your projects ($PROFILE\code-conductor unless PROJECTS_ROOT is set), Git, claude and the user PATH entry."
SectionEnd

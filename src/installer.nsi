; Per-user installer + uninstaller. Built by build.mjs, which passes
; -DVERSION -DSOURCE -DBRANCH -DSTAGE -DOUTFILE -DLAUNCHER -DICON.
; /PROJECTS=<dir> sets the projects folder (also when silent).
; What it relies on from cc (launcher path and exit codes, layout):
; https://github.com/UnmanagedCode/code-conductor/blob/main/docs/windows.md#installer-contract
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"
!include "TextFunc.nsh"
!include "WordFunc.nsh"
!insertmacro WordReplace

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\code-conductor"

Name "code-conductor"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\code-conductor"
SetCompressor /SOLID zlib
ShowInstDetails show

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\code-conductor.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch code-conductor"
!define MUI_FINISHPAGE_TEXT "code-conductor is installed. Your projects live in $ProjectsRoot.$\r$\n$\r$\nIf you have not signed in to Claude yet, run $\"claude auth login$\" once in a terminal."

; Set only once every install step succeeded; the finish page ("installed",
; launch checkbox) is skipped otherwise.
Var InstallOk
; The projects folder: /PROJECTS=, else the user PROJECTS_ROOT, else the
; default (the launcher's own, which an inherited PROJECTS_ROOT overrides).
Var ProjectsRoot

SpaceTexts none
!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE"
!define MUI_PAGE_HEADER_TEXT "Projects folder"
!define MUI_DIRECTORYPAGE_TEXT_TOP "Choose the folder that holds your projects and code-conductor's .code-conductor store. It is kept when you uninstall. Changing it does not move existing projects."
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Projects folder"
!define MUI_DIRECTORYPAGE_VARIABLE $ProjectsRoot
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE FinishPre
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; The projects folder as the launcher would resolve it: the user
; PROJECTS_ROOT, else an inherited one, else the default. Leaves it in $ProjectsRoot.
!macro ResolveProjectsRoot
  ReadRegStr $ProjectsRoot HKCU "Environment" "PROJECTS_ROOT"
  ExpandEnvStrings $ProjectsRoot $ProjectsRoot
  ${If} $ProjectsRoot == ""
    ReadEnvStr $ProjectsRoot PROJECTS_ROOT
  ${EndIf}
  ${If} $ProjectsRoot == ""
    StrCpy $ProjectsRoot "$PROFILE\code-conductor"
  ${EndIf}
!macroend

; Reads /PROJECTS= from $CMDLINE into $ProjectsRoot and sets $R9 to 1 when
; the switch is present. GetOptions is not used: it misses the whole-token
; quoted form and truncates at a second "/". Accepted forms:
;   /PROJECTS="D:\My projects"   /PROJECTS=D:/x   "/PROJECTS=D:\My projects"
; The switch must start a token (line start, after a space or a quote). A
; quoted value, or a whole-token quote, ends at the next quote; an unquoted
; value ends at the next space. "/" in the value becomes "\".
Function ParseProjectsSwitch
  StrCpy $R9 0
  StrCpy $ProjectsRoot ""
  StrLen $R0 $CMDLINE
  StrCpy $R1 0
  ${Do}
    ${If} $R1 >= $R0
      ${Break}
    ${EndIf}
    StrCpy $R2 $CMDLINE 10 $R1
    ${If} $R2 == "/PROJECTS="
      StrCpy $R3 " "
      ${If} $R1 > 0
        IntOp $R4 $R1 - 1
        StrCpy $R3 $CMDLINE 1 $R4
      ${EndIf}
      ${If} $R3 == " "
      ${OrIf} $R3 == '"'
        StrCpy $R9 1
        IntOp $R5 $R1 + 10
        StrCpy $R6 $CMDLINE "" $R5
        ; $R7: the character that ends the value
        StrCpy $R7 " "
        ${If} $R3 == '"'
          StrCpy $R7 '"'
        ${Else}
          StrCpy $R4 $R6 1
          ${If} $R4 == '"'
            StrCpy $R7 '"'
            StrCpy $R6 $R6 "" 1
          ${EndIf}
        ${EndIf}
        StrLen $R8 $R6
        StrCpy $R5 0
        ${Do}
          ${If} $R5 >= $R8
            ${Break}
          ${EndIf}
          StrCpy $R4 $R6 1 $R5
          ${If} $R4 == $R7
            ${Break}
          ${EndIf}
          StrCpy $ProjectsRoot "$ProjectsRoot$R4"
          IntOp $R5 $R5 + 1
        ${Loop}
        ${Break}
      ${EndIf}
    ${EndIf}
    IntOp $R1 $R1 + 1
  ${Loop}
  ${WordReplace} "$ProjectsRoot" "/" "\" "+*" $ProjectsRoot
FunctionEnd

Function .onInit
  Call ParseProjectsSwitch
  ${If} $R9 == 1
    ; A given switch is never silently replaced by another folder.
    ${If} $ProjectsRoot == ""
      MessageBox MB_OK|MB_ICONSTOP "/PROJECTS= needs a folder, for example /PROJECTS=$\"D:\My projects$\"." /SD IDOK
      Abort
    ${EndIf}
  ${Else}
    !insertmacro ResolveProjectsRoot
  ${EndIf}
FunctionEnd

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
      ${TrimNewLines} "$1" $1
      !insertmacro SetupLog "installer: launcher --status exited $0: $1"
      ${If} $0 == 0
        MessageBox MB_YESNO|MB_ICONQUESTION "code-conductor is running and must be stopped first. Stop it now?" /SD IDYES IDYES ${PREFIX}stop
        !insertmacro SetupLog "installer: stopping code-conductor was declined"
        Abort
        ${PREFIX}stop:
        nsExec::ExecToStack '"$INSTDIR\node\node.exe" "$INSTDIR\app\${LAUNCHER}" --stop'
        Pop $0
        Pop $1
        ${TrimNewLines} "$1" $1
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
  File "${STAGE}\setup.mjs"
  File "${STAGE}\toolchain.mjs"
  File "${STAGE}\contract.mjs"
  File "${STAGE}\projects.mjs"
  File "${STAGE}\pins.json"
  ; Windows argv rule: backslashes before the closing quote escape it unless
  ; doubled, so each trailing backslash is doubled; a drive root reaches
  ; setup.mjs intact.
  ; setup.mjs's checkProjectsRoot is the one place that strips a non-root one.
  StrCpy $R2 ""
  StrCpy $R3 $ProjectsRoot
  StrCpy $0 $R3 1 -1
  ${DoWhile} $0 == "\"
    StrCpy $R2 "$R2\"
    StrCpy $R3 $R3 -1
    StrCpy $0 $R3 1 -1
  ${Loop}
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$PLUGINSDIR\setup.mjs" --install-dir "$INSTDIR" --source "${SOURCE}" --branch "${BRANCH}" --projects-root "$ProjectsRoot$R2"'
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
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "UnmanagedCode"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\code-conductor.exe"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0

  CreateShortcut "$SMPROGRAMS\code-conductor.lnk" "$INSTDIR\code-conductor.exe" "" "$INSTDIR\code-conductor.exe" 0

  ; The finish page's Launch inherits this process's environment, which
  ; predates setup's PROJECTS_ROOT write.
  System::Call 'kernel32::SetEnvironmentVariable(t "PROJECTS_ROOT", t "$ProjectsRoot")'
  ; the user PATH and PROJECTS_ROOT may have changed
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  StrCpy $InstallOk 1
SectionEnd

; Keeps the projects root (and the user PROJECTS_ROOT naming it) with its
; store, Git, claude and the PATH entry.
Section "Uninstall"
  SetShellVarContext current
  !insertmacro StopRunning "u"
  Delete "$SMPROGRAMS\code-conductor.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  !insertmacro ResolveProjectsRoot
  DetailPrint "Kept: your projects ($ProjectsRoot), the user PROJECTS_ROOT variable, Git, claude and the user PATH entry."
SectionEnd

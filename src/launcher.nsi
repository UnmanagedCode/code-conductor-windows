; Start-menu stub: a GUI-subsystem exe (no console flash) that runs the
; bundled node on cc's launcher, which holds all launcher logic. It only knows
; two paths relative to itself, plus the stored port (port.nsh), which it
; exports as PORT to the launcher. On failure it shows the launcher's output.
; Built by build.mjs: makensis -DOUTFILE=<path> -DLAUNCHER=<path in the checkout> -DICON=<ico> launcher.nsi
; The launcher's path and exit codes are cc's installer contract:
; https://github.com/UnmanagedCode/code-conductor/blob/main/docs/windows.md#installer-contract
Unicode true
!include "${__FILEDIR__}\port.nsh"
Name "code-conductor"
OutFile "${OUTFILE}"
Icon "${ICON}"
RequestExecutionLevel user
SilentInstall silent
ShowInstDetails nevershow

Section
  !insertmacro UseStoredPort
  nsExec::ExecToStack '"$EXEDIR\node\node.exe" "$EXEDIR\app\${LAUNCHER}"'
  Pop $0
  Pop $1
  StrCmp $0 "0" done
  MessageBox MB_ICONSTOP|MB_OK "code-conductor could not start.$\r$\n$\r$\n$1"
  done:
SectionEnd

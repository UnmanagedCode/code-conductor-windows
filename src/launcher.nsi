; Start-menu stub: a GUI-subsystem exe (no console flash) that runs the
; bundled node on cc's launcher, which holds all launcher logic. It only knows
; two paths relative to itself. On failure it shows the launcher's output.
; Built by build.mjs: makensis -DOUTFILE=<path> -DLAUNCHER=<path in the checkout> launcher.nsi
; The launcher's path and exit codes are cc's installer contract:
; https://github.com/UnmanagedCode/code-conductor/blob/main/docs/windows.md#installer-contract
Unicode true
Name "code-conductor"
OutFile "${OUTFILE}"
RequestExecutionLevel user
SilentInstall silent
ShowInstDetails nevershow

Section
  nsExec::ExecToStack '"$EXEDIR\node\node.exe" "$EXEDIR\app\${LAUNCHER}"'
  Pop $0
  Pop $1
  StrCmp $0 "0" done
  MessageBox MB_ICONSTOP|MB_OK "code-conductor could not start.$\r$\n$\r$\n$1"
  done:
SectionEnd

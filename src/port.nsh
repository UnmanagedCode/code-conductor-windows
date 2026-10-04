; The port cc listens on, as the installer and the Start-menu stub share it:
; stored by the installer at HKCU\Software\code-conductor "Port", exported to
; cc's launcher as PORT (the only way cc takes a port).
!include "LogicLib.nsh"

!define PORT_KEY "Software\code-conductor"
!define PORT_NAME "Port"
; Mirrors cc's portOf default; tests/checkout.real.test.mjs pins it.
!define DEFAULT_PORT 8787

; Sets PORT in this process's environment from the stored port. With none
; stored the environment is left alone (an inherited PORT, else the default).
; Clobbers $0.
!macro UseStoredPort
  ReadRegStr $0 HKCU "${PORT_KEY}" "${PORT_NAME}"
  ${If} $0 != ""
    System::Call 'kernel32::SetEnvironmentVariable(t "PORT", t r0)'
  ${EndIf}
!macroend

; Preserve both installed and portable measurements. Remove only this
; installation's own startup entry on a real uninstall, never during updates.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Netzwerk-Kompass"
    StrCmp $0 '$\"$INSTDIR\Netzwerk-Kompass.exe$\"' 0 +2
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Netzwerk-Kompass"
  ${endIf}
!macroend

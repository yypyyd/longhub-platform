Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef STAGE_DIR
  !error "STAGE_DIR is required"
!endif
!ifndef OUTPUT_DIR
  !error "OUTPUT_DIR is required"
!endif

Name "LongHub Manager"
OutFile "${OUTPUT_DIR}\LongHub-Manager-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\LongHub Manager"
InstallDirRegKey HKCU "Software\LongHub\Manager" "InstallDir"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "LongHub Manager"
VIAddVersionKey "FileDescription" "LongHub Manager Windows Installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "LongHub"

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "LongHub Manager" SEC_MAIN
  Sleep 1500
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File "${STAGE_DIR}\LongHubManager.exe"
  File "${STAGE_DIR}\release-config.json"

  CreateDirectory "$INSTDIR\recovery"
  CopyFiles /SILENT "$EXEPATH" "$INSTDIR\recovery\LongHub-Manager-Setup-${VERSION}.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\LongHub Manager"
  CreateShortcut "$SMPROGRAMS\LongHub Manager\LongHub Manager.lnk" "$INSTDIR\LongHubManager.exe"
  CreateShortcut "$DESKTOP\LongHub Manager.lnk" "$INSTDIR\LongHubManager.exe"

  WriteRegStr HKCU "Software\LongHub\Manager" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LongHubManager" "DisplayName" "LongHub Manager"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LongHubManager" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LongHubManager" "Publisher" "LongHub"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LongHubManager" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LongHubManager" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LongHubManager" "NoRepair" 1

  ExecShell "open" "$INSTDIR\LongHubManager.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  IfFileExists "$INSTDIR\LongHubManager.exe" 0 +2
    ExecWait '"$INSTDIR\LongHubManager.exe" --remove-autostart'

  Delete "$DESKTOP\LongHub Manager.lnk"
  Delete "$SMPROGRAMS\LongHub Manager\LongHub Manager.lnk"
  RMDir "$SMPROGRAMS\LongHub Manager"

  Delete "$INSTDIR\LongHubManager.exe"
  Delete "$INSTDIR\release-config.json"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\recovery"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LongHubManager"
  DeleteRegKey HKCU "Software\LongHub\Manager"
  ; %APPDATA%\LongHub, Credential Manager records and native .openclaw data
  ; are intentionally retained. They are user data, not installer payloads.
SectionEnd

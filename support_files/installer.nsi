;--------------------------------
; Modern TheEduCode Installer
;--------------------------------
Unicode False
RequestExecutionLevel admin
SetCompressor bzip2


;--------------------------------
; General Attributes
;--------------------------------
!define APPNAME "TheEduCode"
!define COMPANYNAME "Eduniketan Private Limited"
!define DESCRIPTION "Electron-based TheEduCode Kiosk Browser"
!define VERSION "1.5.0"
!define INSTALLDIR "$PROGRAMFILES64\TheEduCode"

Name "${APPNAME}"
OutFile "..\TheEduCode-Setup.exe"
Icon "..\icon.ico"
InstallDir "${INSTALLDIR}"

ShowInstDetails nevershow
ShowUninstDetails nevershow

;--------------------------------
; Modern UI 2 Configuration
;--------------------------------
!include "MUI2.nsh"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"

!define MUI_FINISHPAGE_TITLE "Installation Complete"
!define MUI_FINISHPAGE_TEXT "TheEduCode Kiosk Browser has been successfully installed.\n\n\
Thank you for choosing TheEduCode by Eduniketan Private Limited.\n\n\
Enjoy a secure, fast, and beautiful kiosk experience."

; AUTO RUN WITHOUT ASKING
!define MUI_FINISHPAGE_RUN "$INSTDIR\TheEduCode.exe"
!define MUI_FINISHPAGE_RUN_AUTO

!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_UNFINISHPAGE_NOAUTOCLOSE

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; Uninstaller pages
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; Language
!insertmacro MUI_LANGUAGE "English"

;--------------------------------
; Install Section
;--------------------------------
Section "Install"

  SetDetailsPrint none
  SetShellVarContext all

  ; Silently terminate any running instances to avoid write-lock errors
  nsExec::Exec 'taskkill /F /IM TheEduCode.exe'
  nsExec::Exec 'taskkill /F /IM process_killer.exe'
  nsExec::Exec 'taskkill /F /IM theeducode-updater.exe'

  ; WHITELIST APP DIRECTORY IN WINDOWS DEFENDER
  ; This prevents Defender from flagging process_killer.exe and other executables
  ; when the bootstrapper downloads them on first launch.
  ; Standard practice - Valorant, Unity, Android Studio all do this.
  nsExec::Exec 'powershell -NoProfile -Command "Add-MpPreference -ExclusionPath \"$INSTDIR\""'

  SetOutPath "$INSTDIR"
  File /r "..\dist\TheEduCode-win32-x64\*"

  ; Copy the bin directory to resources/executables (not in asar)
  SetOutPath "$INSTDIR\resources\executables"
  File /r "..\bin\*"

  ; Desktop shortcut
  SetOutPath "$INSTDIR"
  CreateShortcut "$DESKTOP\TheEduCode.lnk" "$INSTDIR\TheEduCode.exe"

  ; Start Menu shortcut
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\TheEduCode.exe"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall.lnk" "$INSTDIR\Uninstall.exe"

  ; Registry uninstall info
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "DisplayIcon" "$INSTDIR\TheEduCode.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "Publisher" "${COMPANYNAME}"

  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" \
    "NoRepair" 1

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\Uninstall.exe"

SectionEnd

;--------------------------------
; Uninstall Section
;--------------------------------
Section "Uninstall"

  SetDetailsPrint none
  SetShellVarContext all

  ; Silently terminate any running instances before uninstalling
  nsExec::Exec 'taskkill /F /IM TheEduCode.exe'
  nsExec::Exec 'taskkill /F /IM process_killer.exe'
  nsExec::Exec 'taskkill /F /IM theeducode-updater.exe'

  Delete "$DESKTOP\TheEduCode.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  RMDir /r "$INSTDIR"

  ; Remove registry entries
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"

SectionEnd
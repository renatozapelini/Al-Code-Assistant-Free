; Instalador do Code Assistants para Windows.
; - instala por usuário, sem administrador, em %LOCALAPPDATA%\Programs;
; - se já houver uma versão instalada, substitui automaticamente;
; - cria a pasta visível de projetos em Documentos\Code Assistants\Projetos;
; - cria atalhos na área de trabalho e no menu Iniciar, com desinstalador;
; - desinstalar NÃO apaga projetos nem chaves: essas pastas ficam fora da instalação.
;
; Compilado no CI com: makensis -DAPP_VERSION=x.y.z -DAPP_EXE=<exe> -DOUTFILE=<setup.exe>

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef APP_EXE
  !define APP_EXE "Code-Assistants.exe"
!endif
!ifndef OUTFILE
  !define OUTFILE "Code-Assistants-setup.exe"
!endif

!define APP_NAME "Code Assistants"
!define APP_ID "CodeAssistants"
!define APP_EXE_NAME "Code-Assistants.exe"
!define PROJECTS_DIR "$DOCUMENTS\Code Assistants\Projetos"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
!define INST_REG_KEY "Software\${APP_ID}"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Code Assistants"
InstallDirRegKey HKCU "${INST_REG_KEY}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetOverwrite on
ShowInstDetails show
ShowUninstDetails show
BrandingText "${APP_NAME} ${APP_VERSION}"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${APP_NAME} ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Este instalador coloca o Code Assistants no seu usuário do Windows, sem precisar de administrador.$\r$\n$\r$\nSe já houver uma versão instalada, ela será substituída automaticamente.$\r$\n$\r$\nSeus projetos ficam em Documentos\Code Assistants\Projetos, e chaves e preferências ficam em AppData. Atualizar ou desinstalar o aplicativo não apaga nenhum dos dois."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE_NAME}"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir o Code Assistants agora"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"

; ------------------------------------------------------------
; Função: fecha o Code Assistants se estiver rodando (instalação)
; ------------------------------------------------------------
Function CloseRunningInstance
  Push $R0
  ExecWait 'taskkill /F /IM "${APP_EXE_NAME}" /T' $R0
  Pop $R0
FunctionEnd

; ------------------------------------------------------------
; Função: fecha o Code Assistants se estiver rodando (desinstalação)
; ------------------------------------------------------------
Function un.CloseRunningInstance
  Push $R0
  ExecWait 'taskkill /F /IM "${APP_EXE_NAME}" /T' $R0
  Pop $R0
FunctionEnd

; ------------------------------------------------------------
; Função: desinstala versão anterior se existir (pelo registro)
; ------------------------------------------------------------
Function RemovePreviousVersion
  Push $R0
  ReadRegStr $R0 HKCU "${UNINST_KEY}" "UninstallString"
  ${If} $R0 != ""
    ; remove silenciosamente a versão anterior
    ExecWait '"$R0" /S' $R0
  ${EndIf}
  Pop $R0
FunctionEnd

; ------------------------------------------------------------
; Seção principal de instalação
; ------------------------------------------------------------
Section "Code Assistants" SecMain
  SetShellVarContext current

  ; Fecha instâncias rodando e remove versão anterior antes de instalar
  Call CloseRunningInstance
  Call RemovePreviousVersion

  SetOutPath "$INSTDIR"
  File "/oname=${APP_EXE_NAME}" "${APP_EXE}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Pastas de trabalho fora da instalação: sobrevivem a atualizações e à desinstalação.
  CreateDirectory "${PROJECTS_DIR}"
  CreateDirectory "$LOCALAPPDATA\Code-Assistants\logs"

  CreateDirectory "$SMPROGRAMS\Code Assistants"
  CreateShortCut "$SMPROGRAMS\Code Assistants\Code Assistants.lnk" "$INSTDIR\${APP_EXE_NAME}" "" "$INSTDIR\${APP_EXE_NAME}" 0
  CreateShortCut "$SMPROGRAMS\Code Assistants\Desinstalar Code Assistants.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\Code Assistants.lnk" "$INSTDIR\${APP_EXE_NAME}" "" "$INSTDIR\${APP_EXE_NAME}" 0

  WriteRegStr HKCU "${INST_REG_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${INST_REG_KEY}" "ProjectsDir" "${PROJECTS_DIR}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Renato Zapelini"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" "$\"$INSTDIR\Uninstall.exe$\" /S"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

; ------------------------------------------------------------
; Seção de desinstalação
; ------------------------------------------------------------
Section "Uninstall"
  SetShellVarContext current

  ; Fecha instâncias rodando antes de remover
  Call un.CloseRunningInstance

  Delete "$DESKTOP\Code Assistants.lnk"
  Delete "$SMPROGRAMS\Code Assistants\Code Assistants.lnk"
  Delete "$SMPROGRAMS\Code Assistants\Desinstalar Code Assistants.lnk"
  RMDir "$SMPROGRAMS\Code Assistants"
  Delete "$INSTDIR\${APP_EXE_NAME}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${INST_REG_KEY}"

  ; Projetos e dados ficam: nada do usuário é apagado por uma desinstalação.
  MessageBox MB_ICONINFORMATION|MB_OK "O aplicativo foi removido.$\r$\n$\r$\nSeus projetos continuam em:$\r$\n${PROJECTS_DIR}$\r$\n$\r$\nChaves e preferências continuam em:$\r$\n$LOCALAPPDATA\Code-Assistants$\r$\n$\r$\nApague essas pastas manualmente se quiser removê-las."
SectionEnd

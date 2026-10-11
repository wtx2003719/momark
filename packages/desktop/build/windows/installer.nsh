; installer.nsh — include via electron-builder’s nsis.include
;
; Windows 适配说明：
;   - 文件关联不再手写注册表：electron-builder.yml 的 fileAssociations
;     已按 executableName (momark.exe) 生成正确的 ProgID 与 open 命令。
;     （旧脚本写死 "$INSTDIR\marktext.exe"，与实际 exe 名不符，指向不存在的程序。）
;   - 卸载清理目录改为 productName 对应的 userData：%APPDATA%\墨记
;     （app.getPath('userData') 跟随 productName，旧脚本清理的
;      %APPDATA%\marktext 是错误目录。）

;======================================================================
; customUnInstall macro cleans up on uninstall
!macro customUnInstall
  MessageBox MB_YESNO "是否同时删除用户设置与数据？" /SD IDNO IDNO SkipRemoval
    SetShellVarContext current
    RMDir /r "$APPDATA\墨记"
  SkipRemoval:
!macroend

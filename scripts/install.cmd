@echo off
rem Locates Node and calls src\install.js. The 0.3.0-alpha.1 Windows zip has no native Fleet or ToolsEngine runtime. Read WINDOWS-QUALIFICATION.txt. Options: -Prefix -AddToPath -Uninstall
powershell.exe -NoProfile -File "%~dp0install.ps1" %*

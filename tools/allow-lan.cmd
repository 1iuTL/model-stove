@echo off
REM Allow phones on the LAN to reach Model Stove's ports 8091 / 8092.
REM
REM Why this is needed: the Windows firewall is BlockInbound by default, and its
REM inbound allow-rules are applied PER PROFILE. Measured on this machine while
REM tethered to a phone hotspot (which Windows classifies as Public):
REM   llama-server.exe : 6 Public inbound rules  -> port 8091 works
REM   node.exe         : 0 rules                 -> port 8092 silently dropped
REM   electron.exe     : 0 rules                 -> shell's own net access blocked
REM Symptom: the phone browser spins forever while the PC looks completely fine.
REM
REM Adding rules requires elevation, so this elevates via UAC.
REM
REM NOTE: keep this file ASCII-only. cmd.exe decodes .bat/.cmd using the OEM code
REM page (936 on Chinese Windows), so UTF-8 Chinese text would come out as mojibake.
REM The Chinese explanation lives in allow-lan.ps1, which is UTF-8 WITH a BOM.

title Allow LAN access to Model Stove
echo.
echo   Requesting administrator rights (a UAC prompt will appear)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0allow-lan.ps1')"
echo   Request sent. If you cancel the UAC prompt, no rules are added.
echo.
timeout /t 3 >nul

@echo off
timeout /t 6 /nobreak > nul
taskkill /IM "DSH Desktop.exe" /F > nul 2>&1
timeout /t 5 /nobreak > nul
start "" "D:\deepseek desktop\DSH Desktop\DSH Desktop.exe"

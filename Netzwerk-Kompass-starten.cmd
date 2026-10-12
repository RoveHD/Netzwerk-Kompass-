@echo off
setlocal
cd /d "%~dp0"
title Netzwerk-Kompass
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0server.js"
) else (
  where node.exe >nul 2>nul
  if errorlevel 1 (
    echo Bitte die portable Ausgabe mit enthaltener Laufzeit verwenden.
    echo Alternativ wird Node.js ab Version 20 benoetigt.
    pause
    exit /b 1
  )
  node.exe "%~dp0server.js"
)
if errorlevel 1 pause

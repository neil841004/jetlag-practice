@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8123

where node >nul 2>nul
if %errorlevel%==0 (
  node serve.js %PORT%
  goto end
)

where python >nul 2>nul
if %errorlevel%==0 (
  start "" "http://localhost:%PORT%/"
  python -m http.server %PORT% --bind 127.0.0.1
  goto end
)

echo.
echo   找不到 node 或 python，無法啟動本機伺服器。
echo   請安裝 Node.js (https://nodejs.org) 後再執行這個檔案。
echo.
pause

:end

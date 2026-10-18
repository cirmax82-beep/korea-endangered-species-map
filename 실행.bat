@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=5175
where python >nul 2>nul || (echo [오류] Python이 설치되어 있지 않습니다. https://www.python.org 에서 설치한 뒤 다시 실행하세요. & pause & exit /b 1)
echo.
echo  멸종위기종 종합관리 앱을 시작합니다: http://localhost:%PORT%
echo  이 창을 닫으면 앱이 종료됩니다.
echo.
start "" /b python -m http.server %PORT% --bind 127.0.0.1
timeout /t 1 /nobreak >nul
start "" http://localhost:%PORT%/
pause >nul

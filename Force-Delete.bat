@echo off
echo ========================================================
echo Force Killing Electron Processes...
echo ========================================================
taskkill /F /IM electron.exe /T

echo.
echo ========================================================
echo Deleting node_modules folder...
echo ========================================================
rmdir /S /Q "C:\Users\Saifs\OneDrive\Pictures\EduCode Browser for Windows\node_modules"

echo.
echo ========================================================
echo Done! The folder has been deleted.
echo ========================================================
pause

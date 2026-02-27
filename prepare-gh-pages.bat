@echo off
setlocal

set "BUILD_DIR=gh-pages-build"

if not exist "%BUILD_DIR%" mkdir "%BUILD_DIR%"

copy /Y "absen-hp.html" "%BUILD_DIR%\index.html" >nul

if errorlevel 1 (
  echo Gagal menyiapkan file GitHub Pages.
  exit /b 1
)

echo Sukses. File siap upload:
echo - %BUILD_DIR%\index.html
echo.
echo Langkah lanjut:
echo 1. Upload isi folder %BUILD_DIR% ke root repo GitHub Pages.
echo 2. Settings ^> Pages ^> Branch main /root.
echo 3. Akses: https://USERNAME.github.io/NAMA-REPO/

endlocal

@echo off
REM Sound Suite Sidecar — Download & Install (Windows)
REM Usage:
REM   install.bat                          # defaults to http://172.16.16.9:3000
REM   install.bat http://192.168.1.50:3000 # custom server
REM   set INSTALL_DIR=D:\sidecar && install.bat  # custom install path
setlocal enabledelayedexpansion

set "SERVER=%~1"
if "!SERVER!"=="" set "SERVER=http://172.16.16.9:3000"
REM Default install dir: <current dir>\sidecar — keeps the user on the drive
REM they invoked the installer from. Override with: set INSTALL_DIR=D:\path
if "!INSTALL_DIR!"=="" set "INSTALL_DIR=%CD%\sidecar"

echo ================================
echo  Sound Suite Sidecar Installer
echo ================================
echo   Server:  !SERVER!
echo   Install: !INSTALL_DIR!
echo.

REM --- Download manifest ---
echo [1/4] Fetching version info...
set "MANIFEST_URL=!SERVER!/sideCar/builds/manifest.json"
set "TMP=%TEMP%\ss-install-%RANDOM%"
mkdir "!TMP!" 2>nul

powershell -Command "try { Invoke-WebRequest -Uri '!MANIFEST_URL!' -OutFile '!TMP!\manifest.json' -ErrorAction Stop } catch { Write-Host '[ERROR] Could not reach !MANIFEST_URL!'; Write-Host '  Make sure the server is running and has a published sidecar build.'; exit 1 }"
if errorlevel 1 goto :cleanup

REM Parse version and sha256 from manifest
for /f "tokens=*" %%v in ('powershell -Command "(Get-Content '!TMP!\manifest.json' | ConvertFrom-Json).version"') do set "VERSION=%%v"
for /f "tokens=*" %%s in ('powershell -Command "(Get-Content '!TMP!\manifest.json' | ConvertFrom-Json).sha256"') do set "EXPECTED_SHA=%%s"

echo   Latest version: v!VERSION!

REM --- Check existing install ---
if exist "!INSTALL_DIR!\VERSION" (
    set /p CURRENT=<"!INSTALL_DIR!\VERSION"
    if "!CURRENT!"=="!VERSION!" (
        echo [OK] Already running v!VERSION! -- nothing to do.
        echo   Start with: !INSTALL_DIR!\start.bat !SERVER!
        goto :cleanup
    )
    echo   Upgrading: v!CURRENT! -^> v!VERSION!
)

REM --- Download tarball ---
echo [2/4] Downloading sidecar-latest.tar.gz...
set "TARBALL_URL=!SERVER!/sideCar/builds/sidecar-latest.tar.gz"
powershell -Command "try { Invoke-WebRequest -Uri '!TARBALL_URL!' -OutFile '!TMP!\sidecar-latest.tar.gz' -ErrorAction Stop } catch { Write-Host '[ERROR] Download failed.'; exit 1 }"
if errorlevel 1 goto :cleanup

REM --- Verify checksum ---
echo [3/4] Verifying checksum...
for /f "tokens=*" %%h in ('powershell -Command "(Get-FileHash '!TMP!\sidecar-latest.tar.gz' -Algorithm SHA256).Hash.ToLower()"') do set "ACTUAL_SHA=%%h"

if /i "!ACTUAL_SHA!" NEQ "!EXPECTED_SHA!" (
    echo [ERROR] Checksum mismatch!
    echo   Expected: !EXPECTED_SHA!
    echo   Got:      !ACTUAL_SHA!
    goto :cleanup
)
echo   SHA-256 OK

REM --- Extract ---
echo [4/4] Installing to !INSTALL_DIR!...

REM Stop running sidecar container if found
where docker >nul 2>&1
if not errorlevel 1 (
    docker ps -q -f name=ss-sidecar >nul 2>&1
    if not errorlevel 1 (
        echo   Stopping running sidecar container...
        docker stop ss-sidecar >nul 2>&1
        docker rm ss-sidecar >nul 2>&1
    )
)

REM Back up config
if exist "!INSTALL_DIR!\config\config.json" (
    copy "!INSTALL_DIR!\config\config.json" "!TMP!\config.json.bak" >nul 2>&1
)

REM Extract tarball — pushd handles drive switching (cd alone won't cross drives,
REM which silently leaves CWD on D: while pointing tar at C:\Users\...\Temp).
pushd "!TMP!"
tar xzf sidecar-latest.tar.gz
if errorlevel 1 (
    echo [ERROR] tar extraction failed. Is GNU tar / bsdtar installed? Windows 10+ ships it by default.
    popd
    goto :cleanup
)
popd

REM Verify the extracted layout exists before we wipe the destination
if not exist "!TMP!\sidecar\server.js" (
    echo [ERROR] Extracted archive is missing sidecar\server.js — tarball may be corrupt or empty.
    goto :cleanup
)

REM Replace install directory
if exist "!INSTALL_DIR!.old" rmdir /s /q "!INSTALL_DIR!.old"
if exist "!INSTALL_DIR!" ren "!INSTALL_DIR!" sidecar.old 2>nul
mkdir "!INSTALL_DIR!" 2>nul
xcopy /s /e /q /y /i "!TMP!\sidecar" "!INSTALL_DIR!" >nul
if errorlevel 1 (
    echo [ERROR] xcopy failed copying from "!TMP!\sidecar" to "!INSTALL_DIR!".
    goto :cleanup
)

REM Restore config
if exist "!TMP!\config.json.bak" (
    mkdir "!INSTALL_DIR!\config" 2>nul
    copy "!TMP!\config.json.bak" "!INSTALL_DIR!\config\config.json" >nul
    echo   Config restored.
)

REM Clean up old backup
if exist "!INSTALL_DIR!.old" rmdir /s /q "!INSTALL_DIR!.old"

echo.
echo ================================
echo  Installed v!VERSION!
echo ================================
echo.
echo Start the sidecar:
echo   cd !INSTALL_DIR!
echo   start.bat !SERVER!
echo.

:cleanup
if exist "!TMP!" rmdir /s /q "!TMP!" 2>nul
endlocal

@echo off
REM Sound Suite Sidecar Launcher (Windows) — standalone download
REM Usage: start.bat [MASTER_URL]
REM   start.bat http://172.16.16.9:3000
REM   set SOUND_SUITE_MASTER_URL=http://172.16.16.9:3000 && start.bat
setlocal enabledelayedexpansion

REM Resolve DIR without trailing backslash
set "DIR=%~dp0"
if "!DIR:~-1!"=="\" set "DIR=!DIR:~0,-1!"

if "%PORT%"=="" set PORT=8098

REM Master URL: positional arg > SOUND_SUITE_MASTER_URL > legacy SERVER_URL
if not "%~1"=="" (
    set "SOUND_SUITE_MASTER_URL=%~1"
    set "SERVER_URL=%~1"
)
if "!SOUND_SUITE_MASTER_URL!"=="" if not "!SERVER_URL!"=="" set "SOUND_SUITE_MASTER_URL=!SERVER_URL!"
if "!SERVER_URL!"=="" if not "!SOUND_SUITE_MASTER_URL!"=="" set "SERVER_URL=!SOUND_SUITE_MASTER_URL!"

if exist "!DIR!\VERSION" (
    set /p VER=<"!DIR!\VERSION"
) else (
    set "VER=unknown"
)

echo Sound Suite Sidecar v!VER!
echo ========================
if defined SOUND_SUITE_MASTER_URL (
    echo Master URL: !SOUND_SUITE_MASTER_URL!
) else (
    echo [WARN] No master URL set. Run: start.bat http://master:3000
)

REM --- Check Docker ---
where docker >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not installed or not in PATH.
    echo   Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/
    pause
    exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker daemon is not running.
    echo   Start Docker Desktop and try again.
    pause
    exit /b 1
)
echo [OK] Docker

REM --- Check Node.js ---
set USE_DOCKER=0
where node >nul 2>&1
if errorlevel 1 (
    echo [INFO] Node.js not found -- running in Docker mode.
    set USE_DOCKER=1
) else (
    for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_VER=%%a
    set "NODE_VER=!NODE_VER:v=!"
    if !NODE_VER! LSS 18 (
        echo [WARN] Node.js too old. v18+ required. Falling back to Docker mode.
        set USE_DOCKER=1
    ) else (
        for /f %%a in ('node -v') do echo [OK] Node.js %%a
    )
)

echo ========================

REM --- Stop any pre-existing ss-sidecar container ---
docker ps -q -f name=ss-sidecar >nul 2>&1
if not errorlevel 1 (
    docker stop ss-sidecar >nul 2>&1
    docker rm ss-sidecar >nul 2>&1
)

REM --- Launch ---
if !USE_DOCKER!==1 (
    echo Starting in Docker mode on port !PORT!...
    if not exist "!DIR!\Dockerfile.run" (
        echo [ERROR] Dockerfile.run not found in !DIR!.
        echo   Re-run install.bat to refresh the install dir, or use Node mode.
        pause
        exit /b 1
    )
    echo Building Docker image ss-sidecar:v!VER! ...
    docker build -t ss-sidecar:v!VER! -f "!DIR!\Dockerfile.run" "!DIR!"
    if errorlevel 1 (
        echo [ERROR] Docker build failed.
        pause
        exit /b 1
    )

    set "DOCKER_CMD=docker run -d --name ss-sidecar --restart unless-stopped"
    set "DOCKER_CMD=!DOCKER_CMD! -p !PORT!:8098"
    set "DOCKER_CMD=!DOCKER_CMD! --add-host=host.docker.internal:host-gateway"
    set "DOCKER_CMD=!DOCKER_CMD! -v /var/run/docker.sock:/var/run/docker.sock"
    set "DOCKER_CMD=!DOCKER_CMD! -v ss-sidecar-config:/app/config"
    set "DOCKER_CMD=!DOCKER_CMD! -e NODE_ENV=production"
    set "DOCKER_CMD=!DOCKER_CMD! -e CONFIG_PATH=/app/config/config.json"
    REM Use !VAR! delayed-expansion — %VAR% inside this if-block is stale.
    if defined SOUND_SUITE_MASTER_URL set "DOCKER_CMD=!DOCKER_CMD! -e SOUND_SUITE_MASTER_URL=!SOUND_SUITE_MASTER_URL!"
    if defined SERVER_URL set "DOCKER_CMD=!DOCKER_CMD! -e SERVER_URL=!SERVER_URL!"
    if defined COMPUTERNAME set "DOCKER_CMD=!DOCKER_CMD! -e SIDECAR_HOSTNAME=!COMPUTERNAME!"

    echo Launching: !DOCKER_CMD! ss-sidecar:v!VER!
    !DOCKER_CMD! ss-sidecar:v!VER!
    if errorlevel 1 (
        echo [ERROR] Docker run failed.
        pause
        exit /b 1
    )
    echo.
    echo Sidecar running as Docker container 'ss-sidecar'.
    echo   Dashboard: http://localhost:!PORT!
    echo   Logs:      docker logs -f ss-sidecar
    echo   Stop:      docker stop ss-sidecar
) else (
    echo Starting on port !PORT!...
    if defined SOUND_SUITE_MASTER_URL echo Connecting to master: !SOUND_SUITE_MASTER_URL!
    set NODE_ENV=production
    set "HOSTNAME=0.0.0.0"
    REM PORT, SOUND_SUITE_MASTER_URL, SERVER_URL are inherited by node from this cmd env.
    node "!DIR!\server.js"
)
endlocal

@echo off
REM Build and run the Sound Suite GPU Orchestrator Agent
REM This container manages multiple GPU Docker containers (embedding, completion,
REM OCR, reranker) via Docker socket.
REM Run this on the same machine as Docker Desktop (Windows GPU machine).
REM
REM The Next.js server (Mac) talks to this agent on port 8098 instead of
REM connecting to the Docker daemon directly. No Docker TCP exposure needed.

set AGENT_NAME=sound-suite-agent
set AGENT_PORT=8098

REM Stop existing agent if running
docker ps -q -f name=%AGENT_NAME% >nul 2>&1
if not errorlevel 1 (
    echo Stopping existing %AGENT_NAME% container...
    docker stop %AGENT_NAME% >nul 2>&1
    docker rm %AGENT_NAME% >nul 2>&1
)

REM Build the agent image from the sideCar directory (parent of scripts/)
echo Building %AGENT_NAME% image...
docker build -t %AGENT_NAME% "%~dp0.."
if %errorlevel% neq 0 goto :failed

echo Starting %AGENT_NAME% on port %AGENT_PORT%...
docker run -d ^
  --name %AGENT_NAME% ^
  --restart unless-stopped ^
  -p %AGENT_PORT%:%AGENT_PORT% ^
  -v /var/run/docker.sock:/var/run/docker.sock ^
  -e AGENT_PORT=%AGENT_PORT% ^
  %AGENT_NAME%

if %errorlevel% neq 0 goto :failed

echo.
echo GPU Orchestrator Agent started successfully.
echo.
echo Endpoints:
echo   Web UI:     http://localhost:%AGENT_PORT%/
echo   Health:     http://localhost:%AGENT_PORT%/health
echo   Status:     http://localhost:%AGENT_PORT%/status
echo   GPU Info:   http://localhost:%AGENT_PORT%/gpu
echo   Containers: http://localhost:%AGENT_PORT%/containers
echo   Acquire:    POST http://localhost:%AGENT_PORT%/acquire   {role}
echo   Release:    POST http://localhost:%AGENT_PORT%/release   {role}
echo   Start:      POST http://localhost:%AGENT_PORT%/start     {role}
echo   Stop:       POST http://localhost:%AGENT_PORT%/stop      {role}
echo   Mode:       POST http://localhost:%AGENT_PORT%/mode      {mode}
echo   Provision:  POST http://localhost:%AGENT_PORT%/provision
echo   Config:     POST http://localhost:%AGENT_PORT%/config
echo.
echo Logs: docker logs -f %AGENT_NAME%
goto :end

:failed
echo Failed to start sidecar agent.
exit /b 1

:end

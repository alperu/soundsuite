@echo off
REM Start vLLM Qwen3-Reranker-8B via Docker
REM Requires: Docker Desktop with GPU support + NVIDIA driver
REM Port: 8099
REM
REM Auto-Management (free GPU VRAM when idle):
REM   Run start-docker-agent.bat to start the sidecar agent that manages this container.
REM   The agent communicates via Docker socket — no Docker TCP daemon exposure needed.
REM   Then toggle "GPU Memory Management" in Admin > Reranking Settings.

set CONTAINER_NAME=vllm-reranker
set PORT=8099
set MODEL=Qwen/Qwen3-Reranker-8B
set GPU_UTIL=0.50

REM Stop existing container if running
docker ps -q -f name=%CONTAINER_NAME% >nul 2>&1
if not errorlevel 1 (
    echo Stopping existing %CONTAINER_NAME% container...
    docker stop %CONTAINER_NAME% >nul 2>&1
    docker rm %CONTAINER_NAME% >nul 2>&1
)

echo Starting vLLM reranker on port %PORT%...
echo Model: %MODEL%
echo GPU memory utilization: %GPU_UTIL%

docker run -d ^
  --gpus all ^
  --name %CONTAINER_NAME% ^
  -p %PORT%:8000 ^
  -v vllm-models:/root/.cache/huggingface ^
  vllm/vllm-openai:v0.9.2 ^
  --model %MODEL% ^
  --task score ^
  --hf-overrides "{\"architectures\": [\"Qwen3ForSequenceClassification\"], \"classifier_from_token\": [\"no\", \"yes\"], \"is_original_qwen3_reranker\": true}" ^
  --gpu-memory-utilization %GPU_UTIL% ^
  --host 0.0.0.0

if %errorlevel% neq 0 goto :failed

echo.
echo Container started successfully.
echo Waiting for model to load - first run downloads ~16GB...
echo.
echo Endpoints:
echo   Score:  http://localhost:%PORT%/score
echo   Rerank: http://localhost:%PORT%/v1/rerank
echo   Health: http://localhost:%PORT%/health
echo.
echo Lifecycle Management:
echo   Run start-docker-agent.bat to start the sidecar agent for auto-management.
echo   The agent handles idle timeout and auto-restart. Configure in Admin ^> Reranking Settings.
echo.
echo Manual:
echo   Logs:  docker logs -f %CONTAINER_NAME%
echo   Stop:  docker stop %CONTAINER_NAME%
echo   Start: docker start %CONTAINER_NAME%
goto :end

:failed
echo Failed to start container.
exit /b 1

:end

#!/bin/bash
# Start vLLM Qwen3-Reranker-8B via Docker
# Requires: Docker Desktop with GPU support + NVIDIA driver
# Port: 8099

CONTAINER_NAME="vllm-reranker"
PORT=8099
MODEL="Qwen/Qwen3-Reranker-8B"
GPU_UTIL=0.15

# Stop existing container if running
if docker ps -q -f name="$CONTAINER_NAME" | grep -q .; then
  echo "Stopping existing $CONTAINER_NAME container..."
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1
  docker rm "$CONTAINER_NAME" >/dev/null 2>&1
fi

echo "Starting vLLM reranker on port $PORT..."
echo "Model: $MODEL"
echo "GPU memory utilization: $GPU_UTIL"

docker run -d \
  --gpus all \
  --name "$CONTAINER_NAME" \
  -p "$PORT:8000" \
  vllm/vllm-openai \
  --model "$MODEL" \
  --task score \
  --hf-overrides '{"architectures": ["Qwen3ForSequenceClassification"], "classifier_from_token": ["no", "yes"], "is_original_qwen3_reranker": true}' \
  --gpu-memory-utilization "$GPU_UTIL" \
  --host 0.0.0.0

if [ $? -eq 0 ]; then
  echo ""
  echo "Container '$CONTAINER_NAME' started."
  echo "Waiting for model to load (first run downloads ~16GB)..."
  echo ""
  echo "Endpoints:"
  echo "  Score:  http://localhost:$PORT/score"
  echo "  Rerank: http://localhost:$PORT/v1/rerank"
  echo ""
  echo "Logs:  docker logs -f $CONTAINER_NAME"
  echo "Stop:  docker stop $CONTAINER_NAME"
else
  echo "Failed to start container."
  exit 1
fi

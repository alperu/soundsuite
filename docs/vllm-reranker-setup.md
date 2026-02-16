# vLLM Reranker Setup (Windows + Qwen3-Reranker-8B)

Deploy Qwen3-Reranker-8B on your Windows GPU machine for reranking in the Sound Suite RAG pipeline.

## Prerequisites

- Windows 11 (or Windows 10 21H2+)
- NVIDIA GPU (A6000 48GB recommended)
- Latest NVIDIA Windows GPU driver installed
- Docker Desktop 4.54+ with WSL2 backend enabled

## Quick Start (Docker — Recommended)

One command to run the reranker on port **8099**:

```bash
docker run -d --gpus all --name vllm-reranker -p 8099:8000 vllm/vllm-openai \
  --model Qwen/Qwen3-Reranker-8B \
  --task score \
  --hf-overrides '{"architectures": ["Qwen3ForSequenceClassification"], "classifier_from_token": ["no", "yes"], "is_original_qwen3_reranker": true}' \
  --gpu-memory-utilization 0.15 \
  --host 0.0.0.0
```

Or use the provided script:

```bash
./scripts/start-reranker.sh
```

First run downloads the model (~16GB) from HuggingFace. Check progress with:

```bash
docker logs -f vllm-reranker
```

### Docker Management

```bash
# View logs
docker logs -f vllm-reranker

# Stop
docker stop vllm-reranker

# Restart
docker start vllm-reranker

# Remove container
docker rm vllm-reranker

# Auto-restart on boot
docker update --restart unless-stopped vllm-reranker
```

---

## Test the Endpoints

Replace `<WINDOWS_IP>` with your Windows machine's IP address (or use `localhost` from the same machine).

### Score endpoint

```bash
curl -X POST "http://<WINDOWS_IP>:8099/score" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3-Reranker-8B",
    "text_1": "What exhibits were filed in the motion?",
    "text_2": "Exhibit A: Declaration of John Smith filed in support of Motion for Summary Judgment"
  }'
```

### Rerank endpoint (Jina/Cohere compatible)

```bash
curl -X POST "http://<WINDOWS_IP>:8099/v1/rerank" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3-Reranker-8B",
    "query": "What exhibits were filed in the motion?",
    "documents": [
      "Exhibit A: Declaration of John Smith",
      "The court held a hearing on January 5",
      "Exhibit B: Medical records from Dr. Johnson",
      "Attorney fees totaled $5,000"
    ]
  }'
```

Response returns documents ranked by relevance score.

### Available API endpoints

| Endpoint | Compatibility |
|----------|--------------|
| `/score` | vLLM native |
| `/v1/rerank` | Jina AI / Cohere compatible |
| `/v2/rerank` | Cohere v2 compatible |

---

## VRAM Budget (A6000 48GB)

| Service | VRAM | Notes |
|---------|------|-------|
| Ollama: llama3.3:70b | ~40GB | Completions (swaps in/out) |
| Ollama: qwen3-embedding:0.6b | ~1.2GB | Embeddings |
| Ollama: olmocr2:7b-q8 | ~8GB | OCR (swaps in/out) |
| **vLLM: Qwen3-Reranker-8B** | **~7GB** | **Auto-managed** |

With GPU Memory Management enabled (see below), the reranker container auto-stops after idle to free VRAM for Ollama, and auto-starts on the next search.

---

## GPU Memory Management (Auto Start/Stop)

Sound Suite can automatically start and stop the reranker container to free GPU VRAM when not in use. This lets Ollama use the full GPU for completions and OCR, while the reranker only loads when needed (~30-60s cold start).

### How It Works

```
Search request → Container auto-starts → Model loads → Rerank → Idle timer starts
                                                                      ↓
                                                        5 min idle → Container stops → GPU VRAM freed
```

### Setup: Sidecar Agent

The Next.js server (Mac) manages the Docker container on the Windows GPU machine via a lightweight sidecar agent. The agent runs as a Docker container on the GPU machine and communicates with the Docker daemon via the local socket — no Docker TCP daemon exposure needed.

#### Step 1: Start the Sidecar Agent

On the **Windows GPU machine**, run:

```bat
sideCar\scripts\start-docker-agent.bat
```

This builds and runs a small Node.js container (`sound-suite-agent`) that:
- Mounts `/var/run/docker.sock` to manage containers
- Exposes a REST API on port **8098**
- Handles idle timer and auto-stop/start logic

#### Step 2: Verify from Mac

```bash
curl http://<WINDOWS_IP>:8098/health
# → {"ok":true,"uptime":42}

curl http://<WINDOWS_IP>:8098/status
# → {"container":{"status":"running",...},"activeRequests":0,...}
```

#### Step 3: Enable in Sound Suite

1. Go to **Admin > Reranking Settings**
2. Toggle **GPU Memory Management** on
3. Click **Test** to verify agent connection
4. Set idle timeout (default: 5 minutes)
5. Use **Start/Stop** buttons for manual control
6. Click **Save**

### Agent API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Agent alive check |
| `GET` | `/status` | All containers, mode, VRAM, idle info |
| `GET` | `/gpu` | nvidia-smi VRAM info per GPU |
| `GET` | `/containers` | All managed containers with status |
| `POST` | `/acquire` | `{role}` — start if needed, reset idle timer |
| `POST` | `/release` | `{role}` — decrement active count, start idle countdown |
| `POST` | `/start` | `{role}` — manual start |
| `POST` | `/stop` | `{role}` — manual stop |
| `POST` | `/mode` | `{mode}` — switch indexing/searching mode |
| `POST` | `/provision` | Pull images, create containers, pull models |
| `POST` | `/config` | Push config (idle timeouts, registry overrides) |

### Environment Variables (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `RERANKER_CONTAINER_NAME` | `vllm-reranker` | Docker container name |
| `RERANKER_AGENT_PORT` | `8098` | Sidecar agent port on remote host |

---

## Integration with Sound Suite

The reranker endpoint can be called from the Sound Suite search pipeline to re-score vector search results before returning them to the user or MCP client.

```
Vector Search (LanceDB) → Top-K candidates → vLLM Rerank → Final ranked results
```

Configure the reranker URL in Sound Suite admin settings:
- **Reranker Host:** `http://<WINDOWS_IP>:8099`
- **Reranker Model:** `Qwen/Qwen3-Reranker-8B`

---

## GPU Fleet Orchestrator

The sidecar agent has been upgraded to a **multi-container orchestrator** that manages all GPU workloads: embedding, completion, OCR, and reranker.

### Container Roles

| Role | Image | Default Port | VRAM | Modes |
|------|-------|-------------|------|-------|
| Embedding | `ollama/ollama` | 11434 | ~1.2GB | Both |
| Completion | `ollama/ollama` | 11435 | ~40GB | Searching |
| OCR | `ollama/ollama` | 11436 | ~8GB | Indexing |
| Reranker | `vllm/vllm-openai` | 8099 | ~7GB | Searching |

Container naming: `ll-embedding`, `ll-completion`, `ll-ocr`, `ll-reranker`.

### Mode Switching (Single-GPU)

For machines with a single GPU (~48GB VRAM), not all models fit simultaneously:

- **Indexing mode**: Embedding + OCR active (~9.2GB)
- **Searching mode**: Embedding + Completion + Reranker active (~48.2GB)
- Embedding never stops (needed in both modes)

Switch modes via `POST /mode {"mode": "indexing"}` or from the Admin UI.

With 2+ GPUs, modes are unnecessary — all containers can run concurrently.

### Fleet Management (Admin UI)

Navigate to **Admin > GPU Fleet** to:

1. **Register sidecars** — add by URL (e.g., `http://10.10.20.5:8098`)
2. **Test connectivity** — checks direct HTTP and WebSocket tunnel
3. **View GPU topology** — VRAM usage bars, temperature per GPU
4. **Control containers** — Start/Stop per role, view active requests
5. **Switch modes** — Indexing vs Searching for single-GPU machines
6. **Provision** — pull images, create containers, pull models (one-click setup)
7. **Configure idle timeouts** — per-role auto-stop, push to all sidecars

### Auto-Manage

When **Auto-Manage GPU Containers** is enabled in Admin > GPU Fleet:
- Embedding, completion, OCR, and reranker providers automatically resolve their host via the fleet router
- The fleet router picks the best available sidecar, starting containers on demand
- Idle containers are automatically stopped after the configured timeout

### Provisioning a New Sidecar

```bash
# 1. Start the orchestrator agent on the GPU machine
cd sideCar && node server.js
# Or via Docker:
sideCar/scripts/start-docker-agent.sh

# 2. Register in Sound Suite Admin > GPU Fleet > Add Sidecar

# 3. Click "Provision" — this pulls images, creates containers, pulls models
```

---

## Alternative: Manual WSL2 Install (without Docker)

If you prefer running vLLM directly instead of via Docker:

### 1. Enable WSL2

Open **PowerShell as Admin**:

```powershell
# Enable WSL and Virtual Machine Platform features
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

**Restart your PC** after both complete.

After reboot, open PowerShell as Admin again:

```powershell
# Set WSL2 as default version
wsl --set-default-version 2

# Update WSL kernel
wsl --update
```

### 2. Install Ubuntu

```powershell
wsl --install -d Ubuntu-24.04
```

> **Troubleshooting:** If you get a `WININET_E_CANNOT_CONNECT` error fetching the distribution list, install Ubuntu manually from the **Microsoft Store** — search for "Ubuntu 24.04" and click Install. This bypasses the GitHub JSON fetch and does the same thing.

Restart your PC when prompted, then open Ubuntu from the Start menu. Set up your Unix username and password on first launch.

### 3. Install NVIDIA CUDA Toolkit in WSL2

> **Important:** Do NOT install NVIDIA Linux drivers inside WSL — the Windows driver passes through automatically.

```bash
# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential python3-dev python3-pip git

# Add NVIDIA CUDA repo (toolkit only — NOT drivers)
wget https://developer.download.nvidia.com/compute/cuda/repos/wsl-ubuntu/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt update

# Install CUDA toolkit ONLY (do NOT install cuda-drivers)
sudo apt install -y cuda-toolkit-12-8

# Add to PATH
echo 'export PATH=/usr/local/cuda/bin:$PATH' >> ~/.bashrc
echo 'export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH' >> ~/.bashrc
source ~/.bashrc

# Verify GPU is visible
nvidia-smi
```

### 4. Set Up Python Environment

```bash
# Install Miniconda
wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
bash Miniconda3-latest-Linux-x86_64.sh -b
eval "$($HOME/miniconda3/bin/conda shell.bash hook)"
conda init

# Create vLLM environment
conda create -n vllm python=3.12 -y
conda activate vllm
```

### 5. Install and Run vLLM

```bash
pip install vllm

vllm serve Qwen/Qwen3-Reranker-8B \
  --host 0.0.0.0 \
  --port 8099 \
  --task score \
  --hf-overrides '{
    "architectures": ["Qwen3ForSequenceClassification"],
    "classifier_from_token": ["no", "yes"],
    "is_original_qwen3_reranker": true
  }' \
  --gpu-memory-utilization 0.15
```

### 6. Auto-Start on Boot (Optional)

```bash
sudo tee /etc/systemd/system/vllm-reranker.service << 'EOF'
[Unit]
Description=vLLM Qwen3 Reranker
After=network.target

[Service]
User=YOUR_USERNAME
Environment="PATH=/home/YOUR_USERNAME/miniconda3/envs/vllm/bin:/usr/local/cuda/bin:/usr/bin"
ExecStart=/home/YOUR_USERNAME/miniconda3/envs/vllm/bin/vllm serve Qwen/Qwen3-Reranker-8B --host 0.0.0.0 --port 8099 --task score --hf-overrides '{"architectures": ["Qwen3ForSequenceClassification"], "classifier_from_token": ["no", "yes"], "is_original_qwen3_reranker": true}' --gpu-memory-utilization 0.15
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable vllm-reranker
sudo systemctl start vllm-reranker
```

Replace `YOUR_USERNAME` with your WSL Ubuntu username.

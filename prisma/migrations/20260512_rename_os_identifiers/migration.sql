-- Rename HostOs identifiers to deployment-aware names.
-- win32  → windows-docker-wsl2  (Docker Desktop with WSL2 backend)
-- darwin → mac-docker-ollama    (native Ollama on Mac host + DMR/vllm-metal for vLLM)
-- linux remains unchanged.

UPDATE "HostProvisioning" SET hostOsOverride = 'windows-docker-wsl2' WHERE hostOsOverride = 'win32';
UPDATE "HostProvisioning" SET hostOsOverride = 'mac-docker-ollama'   WHERE hostOsOverride = 'darwin';

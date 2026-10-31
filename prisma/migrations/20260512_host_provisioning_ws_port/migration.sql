-- Add per-host master WebSocket port override.
-- Sidecars connect WS to <masterHost>:<masterWsPortForHost>/sidecar.
-- Null = use the master-default (3002 / GPU_WS_PORT).
ALTER TABLE "HostProvisioning" ADD COLUMN "masterWsPortForHost" INTEGER;

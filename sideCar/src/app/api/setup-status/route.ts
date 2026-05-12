import { NextResponse } from 'next/server';
import { state, dockerSupportsGpu } from '@/lib/state';

const cors = { 'Access-Control-Allow-Origin': '*' };

const OLLAMA_INSTALL: Record<string, { label: string; steps: string[] }> = {
  darwin: {
    label: 'macOS (Apple Silicon — Metal)',
    steps: [
      'brew install ollama',
      'launchctl setenv OLLAMA_HOST 0.0.0.0:11434',
      'brew services start ollama',
    ],
  },
  win32: {
    label: 'Windows (CUDA / native)',
    steps: [
      'Download installer from https://ollama.com/download/windows',
      'Set system env var OLLAMA_HOST=0.0.0.0:11434',
      'Restart the Ollama service from Services.msc',
    ],
  },
  linux: {
    label: 'Linux (native — usually unnecessary; prefer Docker+NVIDIA)',
    steps: [
      'curl -fsSL https://ollama.com/install.sh | sh',
      'sudo systemctl enable --now ollama',
    ],
  },
  unknown: {
    label: 'Host OS not yet selected',
    steps: ['Pick a host OS above to see install steps'],
  },
};

const DMR_INSTALL = {
  label: 'Docker Model Runner (vllm-metal)',
  steps: [
    'Update Docker Desktop to >= 4.40',
    'Open Docker Desktop → Settings → Features in development → Enable Model Runner',
    'docker model pull Qwen/Qwen3-Reranker-4B',
    'See https://docs.docker.com/ai/model-runner/ for details',
  ],
};

export async function GET() {
  const os = state.hostOs;
  const installOllama = OLLAMA_INSTALL[os] ?? OLLAMA_INSTALL.unknown;

  return NextResponse.json(
    {
      host: {
        os,
        osConfidence: state.hostOsConfidence,
        dockerDesktop: state.hostOsDockerDesktop,
        dockerSupportsGpu: dockerSupportsGpu(),
      },
      hostOllama: {
        enabled: state.hostOllamaEnabled,
        host: state.hostOllamaHost,
        roles: Array.from(state.hostOllamaRoles),
        budgetMb: state.hostOllamaBudgetMb,
        lastHealth: state.hostOllamaLastHealth,
      },
      dmr: {
        enabled: state.dmrEnabled,
        host: state.dmrHost,
        port: state.dmrPort,
        roles: Array.from(state.dmrRoles),
        budgetMb: state.dmrBudgetMb,
        lastHealth: state.dmrLastHealth,
      },
      // Convenience: roles known to the registry (so the UI doesn't hardcode)
      knownRoles: Object.entries(state.registry)
        .filter(([, def]) => def.type !== 'utility')
        .map(([role, def]) => ({ role, type: def.type, model: def.model })),
      installHints: {
        ollama: installOllama,
        dmr: DMR_INSTALL,
      },
    },
    { headers: cors },
  );
}

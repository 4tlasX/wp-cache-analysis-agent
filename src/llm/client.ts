/**
 * Ollama Client with Auto-Pull
 * Handles model management and ensures models are available
 */

import { Ollama } from 'ollama';

export const MODELS = {
  orchestrator: 'qwen2.5:7b',
  analyzer: 'phi3:mini',
} as const;

export type ModelRole = keyof typeof MODELS;

let client: Ollama | null = null;

export function getClient(host?: string): Ollama {
  if (!client) {
    client = new Ollama({ host: host || 'http://127.0.0.1:11434' });
  }
  return client;
}

export async function checkOllamaRunning(): Promise<boolean> {
  try {
    const ollama = getClient();
    await ollama.list();
    return true;
  } catch {
    return false;
  }
}

export async function isModelAvailable(model: string): Promise<boolean> {
  try {
    const ollama = getClient();
    const { models } = await ollama.list();
    return models.some(m => m.name === model || m.name.startsWith(`${model}:`));
  } catch {
    return false;
  }
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
}

export async function pullModel(
  model: string,
  onProgress?: (progress: PullProgress) => void
): Promise<void> {
  const ollama = getClient();

  const stream = await ollama.pull({ model, stream: true });

  for await (const part of stream) {
    if (onProgress) {
      const progress: PullProgress = {
        status: part.status,
      };

      if (part.completed && part.total) {
        progress.completed = part.completed;
        progress.total = part.total;
        progress.percent = Math.round((part.completed / part.total) * 100);
      }

      onProgress(progress);
    }
  }
}

export async function ensureModel(
  model: string,
  onProgress?: (progress: PullProgress) => void
): Promise<void> {
  const available = await isModelAvailable(model);

  if (!available) {
    if (onProgress) {
      onProgress({ status: `Model ${model} not found, downloading...` });
    }
    await pullModel(model, onProgress);
  }
}

export async function ensureAllModels(
  onProgress?: (model: string, progress: PullProgress) => void
): Promise<void> {
  for (const [role, model] of Object.entries(MODELS)) {
    const available = await isModelAvailable(model);

    if (!available) {
      if (onProgress) {
        onProgress(model, { status: `Downloading ${role} model: ${model}` });
      }

      await pullModel(model, (progress) => {
        if (onProgress) {
          onProgress(model, progress);
        }
      });
    }
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  format?: 'json';
}

export async function chat(
  messages: ChatMessage[],
  options: ChatOptions
): Promise<string> {
  const ollama = getClient();

  const response = await ollama.chat({
    model: options.model,
    messages,
    options: {
      temperature: options.temperature ?? 0.7,
    },
    format: options.format,
  });

  return response.message.content;
}

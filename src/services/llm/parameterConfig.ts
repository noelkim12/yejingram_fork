import type { ApiProvider } from '../../entities/setting/types';

export type ParamType = 'number' | 'string' | 'boolean' | 'string[]';

export interface ParamMeta {
  key: string;
  type: ParamType;
  defaultValue: number | string | boolean | string[];
  defaultEnabled: boolean;
  range?: { min: number; max: number; step: number };
  enumValues?: string[];
  providerParamName: Partial<Record<ApiProvider, string | null>>;
  nestedPath?: Partial<Record<ApiProvider, string>>;
}

export const PARAM_DEFINITIONS: Record<string, ParamMeta> = {
  temperature: {
    key: 'temperature',
    type: 'number',
    defaultValue: 1.0,
    defaultEnabled: true,
    range: { min: 0, max: 2, step: 0.01 },
    providerParamName: {
      gemini: 'temperature',
      vertexai: 'temperature',
      claude: 'temperature',
      grok: 'temperature',
      openai: 'temperature',
      deepseek: 'temperature',
      openrouter: 'temperature',
      custom: 'temperature',
    },
  },
  topP: {
    key: 'topP',
    type: 'number',
    defaultValue: 0.95,
    defaultEnabled: true,
    range: { min: 0, max: 1, step: 0.01 },
    providerParamName: {
      gemini: 'topP',
      vertexai: 'topP',
      claude: 'top_p',
      grok: 'top_p',
      openai: 'top_p',
      deepseek: 'top_p',
      openrouter: 'top_p',
      custom: 'top_p',
    },
  },
  topK: {
    key: 'topK',
    type: 'number',
    defaultValue: 40,
    defaultEnabled: true,
    range: { min: 1, max: 100, step: 1 },
    providerParamName: {
      gemini: 'topK',
      vertexai: 'topK',
      claude: 'top_k',
      grok: 'top_k',
      openai: null,
      deepseek: null,
      openrouter: 'top_k',
      custom: 'topK',
    },
  },
  frequencyPenalty: {
    key: 'frequencyPenalty',
    type: 'number',
    defaultValue: 0,
    defaultEnabled: false,
    range: { min: -2, max: 2, step: 0.01 },
    providerParamName: {
      gemini: 'frequencyPenalty',
      vertexai: 'frequencyPenalty',
      claude: null,
      grok: null,
      openai: 'frequency_penalty',
      deepseek: 'frequency_penalty',
      openrouter: 'frequency_penalty',
      custom: 'frequency_penalty',
    },
  },
  presencePenalty: {
    key: 'presencePenalty',
    type: 'number',
    defaultValue: 0,
    defaultEnabled: false,
    range: { min: -2, max: 2, step: 0.01 },
    providerParamName: {
      gemini: 'presencePenalty',
      vertexai: 'presencePenalty',
      claude: null,
      grok: null,
      openai: 'presence_penalty',
      deepseek: 'presence_penalty',
      openrouter: 'presence_penalty',
      custom: 'presence_penalty',
    },
  },
  stopSequences: {
    key: 'stopSequences',
    type: 'string[]',
    defaultValue: [],
    defaultEnabled: false,
    providerParamName: {
      gemini: 'stopSequences',
      vertexai: 'stopSequences',
      claude: 'stop_sequences',
      grok: 'stop_sequences',
      openai: 'stop',
      deepseek: 'stop',
      openrouter: 'stop',
      custom: 'stop',
    },
  },
  seed: {
    key: 'seed',
    type: 'number',
    defaultValue: 0,
    defaultEnabled: false,
    range: { min: 0, max: 999999, step: 1 },
    providerParamName: {
      gemini: 'seed',
      vertexai: 'seed',
      claude: null,
      grok: null,
      openai: null,
      deepseek: null,
      openrouter: null,
      custom: null,
    },
  },
  candidateCount: {
    key: 'candidateCount',
    type: 'number',
    defaultValue: 1,
    defaultEnabled: false,
    range: { min: 1, max: 8, step: 1 },
    providerParamName: {
      gemini: 'candidateCount',
      vertexai: 'candidateCount',
      claude: null,
      grok: null,
      openai: null,
      deepseek: null,
      openrouter: null,
      custom: null,
    },
  },
  thinkingBudget: {
    key: 'thinkingBudget',
    type: 'number',
    defaultValue: 8192,
    defaultEnabled: false,
    range: { min: 1024, max: 131072, step: 1024 },
    providerParamName: {
      gemini: 'thinkingBudget',
      vertexai: 'thinkingBudget',
      claude: 'budget_tokens',
      grok: null,
      openai: null,
      deepseek: null,
      openrouter: null,
      custom: null,
    },
    nestedPath: {
      gemini: 'thinkingConfig',
      vertexai: 'thinkingConfig',
      claude: 'thinking',
    },
  },
  reasoningEffort: {
    key: 'reasoningEffort',
    type: 'string',
    defaultValue: 'medium',
    defaultEnabled: false,
    enumValues: ['low', 'medium', 'high'],
    providerParamName: {
      gemini: null,
      vertexai: null,
      claude: null,
      grok: null,
      openai: 'reasoning_effort',
      deepseek: null,
      openrouter: 'reasoning_effort',
      custom: null,
    },
  },
  doSample: {
    key: 'doSample',
    type: 'boolean',
    defaultValue: true,
    defaultEnabled: false,
    providerParamName: {
      gemini: null,
      vertexai: null,
      claude: null,
      grok: null,
      openai: null,
      deepseek: null,
      openrouter: null,
      custom: 'do_sample',
    },
  },
  logprobs: {
    key: 'logprobs',
    type: 'number',
    defaultValue: 0,
    defaultEnabled: false,
    range: { min: 0, max: 20, step: 1 },
    providerParamName: {
      gemini: 'logprobs',
      vertexai: 'logprobs',
      claude: null,
      grok: null,
      openai: 'top_logprobs',
      deepseek: null,
      openrouter: 'top_logprobs',
      custom: null,
    },
  },
};

export function getProviderParams(provider: ApiProvider): string[] {
  return Object.entries(PARAM_DEFINITIONS)
    .filter(([, meta]) => meta.providerParamName[provider] !== null && meta.providerParamName[provider] !== undefined)
    .map(([key]) => key);
}

export function getParamMeta(key: string): ParamMeta | undefined {
  return PARAM_DEFINITIONS[key];
}

export function getProviderParamName(key: string, provider: ApiProvider): string | null {
  const meta = PARAM_DEFINITIONS[key];
  if (!meta) return null;
  return meta.providerParamName[provider] ?? null;
}

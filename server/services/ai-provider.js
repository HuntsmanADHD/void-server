/**
 * Provider Factory and Base Provider
 * Manages multiple providers with a unified interface
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.resolve(__dirname, '../../data');
const LEGACY_CONFIG_DIR = path.resolve(__dirname, '../../config');
const TEMPLATE_DIR = path.resolve(__dirname, '../../data_template');
const AI_PROVIDERS_CONFIG_PATH = path.join(CONFIG_DIR, 'ai-providers.json');
const LEGACY_AI_PROVIDERS_CONFIG_PATH = path.join(LEGACY_CONFIG_DIR, 'ai-providers.json');
const TEMPLATE_AI_PROVIDERS_CONFIG_PATH = path.join(TEMPLATE_DIR, 'ai-providers.json');

// Default configuration - all providers disabled by default
// Users must configure a provider in Settings before using Chat
// Note: CLI providers (claude, gemini-cli, codex-cli) are disabled in Docker mode
// since they require shell access to CLI tools not available in the container
const DEFAULT_CONFIG = {
  activeProvider: null,
  providers: {
    openai: {
      name: 'OpenAI',
      type: 'api',
      enabled: false,
      endpoint: 'https://api.openai.com/v1',
      apiKey: '',
      description: 'Connect to the OpenAI API using your platform API key.',
      link: 'https://platform.openai.com/docs/overview',
      models: {
        light: 'gpt-4o-mini',
        medium: 'gpt-4o',
        deep: 'gpt-4o'
      },
      settings: {
        temperature: 0.7,
        max_tokens: 4096
      },
      timeout: 120000
    },
    anthropic: {
      name: 'Anthropic API',
      type: 'api',
      enabled: false,
      endpoint: 'https://api.anthropic.com/v1',
      apiKey: '',
      description: 'Call Anthropic\'s Claude models directly via the API.',
      link: 'https://docs.anthropic.com/en/api',
      models: {
        light: 'claude-haiku-4-5',
        medium: 'claude-sonnet-4-6',
        deep: 'claude-opus-4-8'
      },
      settings: {
        temperature: 0.7,
        max_tokens: 4096
      },
      timeout: 120000
    },
    gemini: {
      name: 'Gemini API',
      type: 'api',
      enabled: false,
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: '',
      description: 'Use Google\'s Gemini API with an AI Studio or Cloud key.',
      link: 'https://ai.google.dev/gemini-api',
      models: {
        light: 'gemini-1.5-flash',
        medium: 'gemini-1.5-pro',
        deep: 'gemini-1.5-pro'
      },
      settings: {
        temperature: 0.7,
        max_tokens: 2048
      },
      timeout: 120000
    },
    lmstudio: {
      name: 'LM Studio',
      type: 'api',
      enabled: false,
      endpoint: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      description: 'Run models locally and privately. Download LM Studio, load a model, and start the local server.',
      link: 'https://lmstudio.ai/',
      models: {
        light: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF',
        medium: 'lmstudio-community/Qwen2.5-14B-Instruct-GGUF',
        deep: 'openai/gpt-oss-20b'
      },
      settings: {
        temperature: 0.8,
        max_tokens: 8192
      },
      timeout: 300000
    },
    ollama: {
      name: 'Ollama',
      type: 'api',
      enabled: false,
      endpoint: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      description: 'Run open-source models locally with Ollama. Models download automatically on first use.',
      link: 'https://ollama.ai/',
      models: {
        light: 'llama3.2:3b',
        medium: 'llama3.2:8b',
        deep: 'llama3.1:70b'
      },
      settings: {
        temperature: 0.7,
        max_tokens: 8192
      },
      timeout: 300000
    }
  }
};

// Provider instances
const providers = new Map();
let config = null;

/**
 * Load configuration from disk
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // Migrate from legacy location if needed
  if (fs.existsSync(LEGACY_AI_PROVIDERS_CONFIG_PATH) && !fs.existsSync(AI_PROVIDERS_CONFIG_PATH)) {
    fs.copyFileSync(LEGACY_AI_PROVIDERS_CONFIG_PATH, AI_PROVIDERS_CONFIG_PATH);
    fs.unlinkSync(LEGACY_AI_PROVIDERS_CONFIG_PATH);
    console.log('📦 Migrated ai-providers.json from config/ to data/');
  }

  if (!fs.existsSync(AI_PROVIDERS_CONFIG_PATH)) {
    // Copy from data_template if available, otherwise use defaults
    if (fs.existsSync(TEMPLATE_AI_PROVIDERS_CONFIG_PATH)) {
      fs.copyFileSync(TEMPLATE_AI_PROVIDERS_CONFIG_PATH, AI_PROVIDERS_CONFIG_PATH);
      console.log('🤖 Initialized ai-providers.json from data_template');
    } else {
      fs.writeFileSync(AI_PROVIDERS_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    }
  }

  // Load and merge with defaults
  if (fs.existsSync(AI_PROVIDERS_CONFIG_PATH)) {
    const saved = JSON.parse(fs.readFileSync(AI_PROVIDERS_CONFIG_PATH, 'utf8'));
    const savedProviders = saved.providers || {};
    const mergedProviders = {};

    const providerKeys = new Set([
      ...Object.keys(DEFAULT_CONFIG.providers),
      ...Object.keys(savedProviders)
    ]);

    const orderedKeys = [...providerKeys].sort((a, b) => {
      // Prioritize local AI providers: Ollama first, then LM Studio
      if (a === 'ollama') return -1;
      if (b === 'ollama') return 1;
      if (a === 'lmstudio') return -1;
      if (b === 'lmstudio') return 1;
      return 0;
    });

    for (const key of orderedKeys) {
      const defaultProvider = DEFAULT_CONFIG.providers[key] || {};
      const savedProvider = savedProviders[key] || {};

      mergedProviders[key] = {
        ...defaultProvider,
        ...savedProvider,
        models: { ...defaultProvider.models, ...(savedProvider.models || {}) },
        settings: { ...defaultProvider.settings, ...(savedProvider.settings || {}) }
      };
    }
    // Merge with defaults to ensure new providers are available
    config = {
      ...DEFAULT_CONFIG,
      ...saved,
      providers: mergedProviders
    };
  }

  // Allow environment variable overrides for local AI providers (useful for Docker)
  if (process.env.LM_STUDIO_URL && config.providers.lmstudio) {
    config.providers.lmstudio.endpoint = process.env.LM_STUDIO_URL;
    console.log(`🔧 LM Studio endpoint overridden: ${process.env.LM_STUDIO_URL}`);
  }

  if (process.env.OLLAMA_URL && config.providers.ollama) {
    config.providers.ollama.endpoint = process.env.OLLAMA_URL;
    console.log(`🔧 Ollama endpoint overridden: ${process.env.OLLAMA_URL}`);
  }

  return config;
}

/**
 * Save configuration to disk
 */
function saveConfig() {
  if (!config) return;
  fs.writeFileSync(AI_PROVIDERS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Get all providers configuration
 */
function getProviders() {
  if (!config) loadConfig();

  const result = {};
  for (const [key, providerConfig] of Object.entries(config.providers)) {
    const defaults = DEFAULT_CONFIG.providers[key] || {};
    const mergedConfig = { ...defaults, ...providerConfig };

    result[key] = {
      ...mergedConfig,
      active: key === config.activeProvider,
      // Mask API key for security
      apiKey: mergedConfig.apiKey ? '••••••••' : ''
    };
  }

  return {
    activeProvider: config.activeProvider,
    providers: result
  };
}

/**
 * Get active provider configuration
 */
function getActiveProvider() {
  if (!config) loadConfig();
  const providerKey = config.activeProvider;
  const defaults = DEFAULT_CONFIG.providers[providerKey] || {};
  const mergedConfig = { ...defaults, ...config.providers[providerKey] };
  return {
    key: providerKey,
    ...mergedConfig
  };
}

/**
 * Switch active provider
 */
function switchProvider(providerKey) {
  if (!config) loadConfig();

  if (!config.providers[providerKey]) {
    return { success: false, error: `Provider "${providerKey}" not found` };
  }

  if (!config.providers[providerKey].enabled) {
    return { success: false, error: `Provider "${providerKey}" is disabled` };
  }

  config.activeProvider = providerKey;
  saveConfig();

  return {
    success: true,
    activeProvider: providerKey,
    message: `Switched to ${config.providers[providerKey].name}`
  };
}

/**
 * Update provider configuration
 */
function updateProviderConfig(providerKey, updates) {
  if (!config) loadConfig();

  if (!config.providers[providerKey]) {
    return { success: false, error: `Provider "${providerKey}" not found` };
  }

  // Merge updates (don't overwrite apiKey with masked value)
  const currentConfig = config.providers[providerKey];

  if (updates.apiKey === '••••••••' || updates.apiKey === '') {
    delete updates.apiKey;
  }

  config.providers[providerKey] = {
    ...currentConfig,
    ...updates,
    // Deep merge for nested objects
    models: { ...currentConfig.models, ...(updates.models || {}) },
    settings: { ...currentConfig.settings, ...(updates.settings || {}) }
  };

  saveConfig();

  // Re-register provider if it was updated
  registerProvider(providerKey);

  return {
    success: true,
    provider: providerKey,
    message: `Updated ${config.providers[providerKey].name} configuration`
  };
}

/**
 * Register a single provider
 */
function registerProvider(providerKey) {
  if (!config) loadConfig();

  const providerConfig = config.providers[providerKey];
  if (!providerConfig || !providerConfig.enabled) {
    providers.delete(providerKey);
    return;
  }

  // Load provider implementation based on type
  let ProviderClass;

  switch (providerKey) {
    case 'openai':
    case 'lmstudio':
    case 'ollama':
      ProviderClass = require('./providers/openai-provider');
      break;
    case 'anthropic':
      ProviderClass = require('./providers/anthropic-provider');
      break;
    case 'gemini':
      ProviderClass = require('./providers/gemini-provider');
      break;
    default:
      console.log(`⚠️ Unknown provider type: ${providerKey}`);
      return;
  }

  providers.set(providerKey, new ProviderClass(providerConfig));
  console.log(`🤖 Registered AI provider: ${providerConfig.name}`);
}

/**
 * Register all enabled providers
 */
function registerProviders() {
  if (!config) loadConfig();

  providers.clear();

  for (const providerKey of Object.keys(config.providers)) {
    registerProvider(providerKey);
  }
}

/**
 * Test provider connection
 */
async function testProvider(providerKey) {
  if (!config) loadConfig();

  const providerConfig = config.providers[providerKey];
  if (!providerConfig) {
    return { success: false, error: `Provider "${providerKey}" not found` };
  }

  const provider = providers.get(providerKey);
  if (!provider) {
    return { success: false, error: `Provider "${providerKey}" not registered (may be disabled)` };
  }

  return provider.testConnection();
}

/**
 * Generate content using active provider
 */
async function generate(prompt, options = {}) {
  if (!config) loadConfig();

  const providerKey = config.activeProvider;
  const provider = providers.get(providerKey);

  if (!provider) {
    throw new Error(`Active provider "${providerKey}" not available`);
  }

  return provider.generate(prompt, options);
}

/**
 * Get provider instance
 */
function getProvider(providerKey) {
  return providers.get(providerKey || config?.activeProvider);
}

/**
 * Initialize the AI provider system
 */
function initialize() {
  loadConfig();
  registerProviders();
  console.log(`🤖 AI Provider system initialized (active: ${config.activeProvider})`);
}

module.exports = {
  initialize,
  loadConfig,
  saveConfig,
  getProviders,
  getActiveProvider,
  switchProvider,
  updateProviderConfig,
  testProvider,
  generate,
  getProvider,
  registerProviders
};

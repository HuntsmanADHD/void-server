/**
 * Anthropic API Provider
 * Direct API access to Claude models via Anthropic's API
 */

const BaseProvider = require('./base-provider');
const http = require('../../lib/http-client');

class AnthropicProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.endpoint = config.endpoint || 'https://api.anthropic.com/v1';
    this.apiKey = config.apiKey || '';
    this.settings = config.settings || {};
    this.apiVersion = config.apiVersion || '2023-06-01';
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion
    };
  }

  async generate(prompt, options = {}) {
    const modelType = options.modelType || 'default';
    const model = this.getModel(modelType);

    const messages = options.messages || [
      { role: 'user', content: prompt }
    ];

    const body = {
      model,
      messages,
      max_tokens: options.max_tokens ?? this.settings.max_tokens ?? 4096,
      ...(options.systemPrompt && { system: options.systemPrompt }),
      ...(this.settings.temperature && { temperature: this.settings.temperature })
    };

    const startTime = Date.now();

    const result = await http.post(`${this.endpoint}/messages`, {
      headers: this.getHeaders(),
      body,
      timeout: this.timeout
    });

    const duration = Date.now() - startTime;

    if (!result.ok) {
      return {
        success: false,
        error: result.data?.error?.message || `API error: ${result.status}`,
        duration
      };
    }

    const content = result.data?.content?.[0]?.text;

    if (!content) {
      return {
        success: false,
        error: 'No content in response',
        duration
      };
    }

    return {
      success: true,
      content,
      model,
      duration,
      usage: result.data?.usage,
      stopReason: result.data?.stop_reason
    };
  }

  async testConnection() {
    // Anthropic doesn't have a models endpoint, so we test with a simple message
    const result = await this.generate('Say "connected" in exactly that word.', {
      modelType: 'quick',
      max_tokens: 20
    });

    if (result.success) {
      return {
        success: true,
        message: `Connected to Anthropic API (${result.duration}ms response time)`
      };
    }

    return {
      success: false,
      error: result.error || 'Connection test failed'
    };
  }

  async getModels() {
    // Anthropic doesn't have a public models endpoint
    // Return the configured models
    return {
      success: true,
      models: [
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Balanced performance' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Fast and efficient' },
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', description: 'Most capable' }
      ],
      configured: Object.entries(this.config.models || {}).map(([type, model]) => ({
        type,
        model,
        description: this.getModelDescription(type)
      }))
    };
  }

  validateConfig() {
    const base = super.validateConfig();
    const errors = base.errors || [];

    if (!this.apiKey) {
      errors.push('Anthropic API key is required');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}

module.exports = AnthropicProvider;

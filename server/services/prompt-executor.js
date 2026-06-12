/**
 * Prompt Executor Service
 * Orchestrates prompt execution with provider resolution
 */

const promptService = require('./prompt-service');
const chatService = require('./chat-service');
const aiProvider = require('./ai-provider');
const memoryQueryService = require('./memory-query-service');
const memoryExtractor = require('./memory-extractor');
const { getNeo4jService } = require('./neo4j-service');

/**
 * Resolve which provider to use based on priority:
 * 1. options.providerOverride (caller override)
 * 2. template.provider (per-template config)
 * 3. global active provider
 */
function resolveProvider(template, options = {}) {
  // Priority 1: Caller override
  if (options.providerOverride) {
    const provider = aiProvider.getProvider(options.providerOverride);
    if (provider) {
      return {
        provider,
        key: options.providerOverride,
        source: 'override'
      };
    }
    console.log(`⚠️ Provider override "${options.providerOverride}" not available, falling back`);
  }

  // Priority 2: Template-configured provider
  if (template?.provider?.key) {
    const provider = aiProvider.getProvider(template.provider.key);
    if (provider) {
      return {
        provider,
        key: template.provider.key,
        modelType: template.provider.modelType,
        source: 'template'
      };
    }
    console.log(`⚠️ Template provider "${template.provider.key}" not available, falling back`);
  }

  // Priority 3: Global active provider
  const activeConfig = aiProvider.getActiveProvider();
  const provider = aiProvider.getProvider(activeConfig.key);

  return {
    provider,
    key: activeConfig.key,
    source: 'active'
  };
}

/**
 * Execute a prompt template with variable substitution
 */
async function executePrompt(templateId, variableValues = {}, options = {}) {
  // Build the prompt from template
  const buildResult = promptService.buildPrompt(templateId, variableValues);
  if (!buildResult.success) {
    return buildResult;
  }

  const { prompt, template } = buildResult;

  // Resolve provider
  const { provider, key, modelType, source } = resolveProvider(template, options);

  if (!provider) {
    return {
      success: false,
      error: 'No provider available'
    };
  }

  // Merge settings from template with options
  const settings = {
    ...template.settings,
    ...options.settings
  };

  // Determine model type
  const finalModelType = options.modelType || modelType || 'medium';

  console.log(`🤖 Executing prompt "${template.name}" with ${key} (${source})`);

  const startTime = Date.now();

  // Execute generation
  const result = await provider.generate(prompt, {
    modelType: finalModelType,
    temperature: settings.temperature,
    max_tokens: settings.max_tokens,
    ...options.generationOptions
  });

  const duration = Date.now() - startTime;

  if (!result.success) {
    console.log(`❌ Prompt execution failed: ${result.error}`);
    return {
      success: false,
      error: result.error,
      provider: key,
      duration
    };
  }

  console.log(`✅ Prompt executed in ${duration}ms`);

  return {
    success: true,
    content: result.content,
    provider: key,
    model: result.model,
    duration: result.duration || duration,
    usage: result.usage,
    template: {
      id: template.id,
      name: template.name
    }
  };
}

/**
 * Normalize structured history into a valid chat-completion messages array:
 * drops empty turns, merges consecutive same-role messages, and ensures the
 * conversation starts with a user turn (the Anthropic API rejects otherwise).
 */
function buildChatMessages(history) {
  const messages = [];

  for (const msg of history) {
    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (!content) continue;

    const role = msg.role === 'user' ? 'user' : 'assistant';
    const last = messages[messages.length - 1];

    if (last && last.role === role) {
      last.content += `\n\n${content}`;
    } else {
      messages.push({ role, content });
    }
  }

  // The history window may open on an assistant turn, but the API requires
  // the first message to be 'user'. Fold it into the following user turn as
  // quoted context instead of discarding it. (Merging above guarantees at
  // most one leading assistant turn.)
  if (messages.length > 0 && messages[0].role === 'assistant') {
    const orphan = messages.shift();
    if (messages.length > 0) {
      messages[0].content =
        `[Earlier in this conversation, the assistant said:]\n${orphan.content}\n\n${messages[0].content}`;
    }
  }

  return messages;
}

/**
 * Marker substituted for {{userMessage}} when rendering a template to derive
 * the system prompt. Everything from the line containing it onward is the
 * transcript scaffold ("User: ...\nClawed:") and gets cut, regardless of how
 * the template names its speakers.
 */
const SCAFFOLD_SENTINEL = '\u0000VOID_SCAFFOLD_SPLIT\u0000';

/**
 * Cut the transcript scaffold from a template rendered with the sentinel as
 * the user message, leaving only the system portion (persona/context/memory).
 */
function stripTranscriptScaffold(prompt) {
  const idx = prompt.indexOf(SCAFFOLD_SENTINEL);
  if (idx === -1) {
    // Template doesn't interpolate {{userMessage}} — nothing to strip, but
    // flag it since chat templates are expected to reference it
    console.log('⚠️ Chat template has no {{userMessage}} placeholder; using full render as system prompt');
    return prompt.trim();
  }

  const lineStart = prompt.lastIndexOf('\n', idx);
  return prompt.slice(0, lineStart === -1 ? 0 : lineStart).trim();
}

/**
 * Execute a chat message within a chat session
 */
async function executeChat(chatId, userMessage, options = {}) {
  // Get chat session
  const chat = chatService.getChat(chatId);
  if (!chat) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  // Get template
  const template = promptService.getTemplate(chat.templateId);
  if (!template) {
    return { success: false, error: `Template "${chat.templateId}" not found` };
  }

  // Get turn number BEFORE adding the message (will be +1 after addMessage)
  const turnNumber = chatService.getCurrentTurnNumber(chatId) + 1;

  // Add user message to chat
  chatService.addMessage(chatId, {
    role: 'user',
    content: userMessage
  });

  // Get chat history for context (formatted strings, used by the plaintext
  // template for CLI providers and turn logging)
  const chatHistory = chatService.getChatHistory(chatId, options.maxHistory || 20);

  // Structured history for chat-completion APIs (Anthropic/OpenAI/Gemini).
  // Ends with the user message we just added, so it is the full turn list.
  const structuredMessages = buildChatMessages(
    chatService.getChatMessages(chatId, options.maxHistory || 20)
  );

  // Query relevant memories if Neo4j is available and memory is enabled
  let memoryContext = '';
  let relevantMemories = [];
  const neo4j = getNeo4jService();
  const globalMemoryEnabled = neo4j.isMemoryEnabled();
  const useMemory = globalMemoryEnabled && options.useMemory !== false; // Check both global and per-request

  if (useMemory && await neo4j.isAvailable()) {
    relevantMemories = await memoryQueryService.getRelevantMemories({
      message: userMessage,
      userHandle: options.userHandle,
      category: template.category || options.category,
      limit: 5
    });

    if (relevantMemories.length > 0) {
      memoryContext = memoryQueryService.formatMemoriesForPrompt(relevantMemories);
      console.log(`🧠 Retrieved ${relevantMemories.length} relevant memories for chat`);
    }
  } else if (!useMemory) {
    console.log(`🧠 Memory disabled for this request`);
  }

  // Get memory instructions for LLM to tag memorable content
  const memoryInstructions = memoryExtractor.getMemoryInstructions();

  // Build variable values - include chat history and memory context
  const variableValues = {
    userMessage,
    chatHistory: chatHistory.slice(0, -1), // Exclude the message we just added
    memoryContext,
    memoryInstructions,
    ...options.variables
  };

  // Determine provider - chat provider override takes precedence
  const providerOverride = options.providerOverride || chat.providerOverride;

  // Build the prompt to capture it for debug mode
  const buildResult = promptService.buildPrompt(chat.templateId, variableValues);
  if (!buildResult.success) {
    return buildResult;
  }

  // Render the template without the transcript to get the system prompt
  // (persona + system context + memory). The transcript itself is sent as a
  // structured messages array so the API enforces turn boundaries instead of
  // the model completing a plaintext document.
  const systemBuild = promptService.buildPrompt(chat.templateId, {
    ...variableValues,
    chatHistory: [],
    userMessage: SCAFFOLD_SENTINEL
  });
  const systemPrompt = systemBuild.success
    ? stripTranscriptScaffold(systemBuild.prompt)
    : '';

  // Only use the structured form when it's a valid conversation for the API:
  // non-empty and ending on the user turn we just added (a whitespace-only
  // message would be dropped by buildChatMessages, leaving a trailing
  // assistant turn, which the API rejects as a prefill). messages and
  // systemPrompt travel together — sending the system prompt alongside the
  // plaintext-document fallback would duplicate the persona.
  const useStructured =
    structuredMessages.length > 0 &&
    structuredMessages[structuredMessages.length - 1].role === 'user';

  // Resolve provider for logging
  const { key: resolvedProviderKey } = resolveProvider(template, { providerOverride });

  // Log turn request
  chatService.logTurnRequest(chatId, turnNumber, {
    timestamp: new Date().toISOString(),
    userMessage,
    compiledPrompt: buildResult.prompt,
    systemPrompt,
    structuredMessageCount: structuredMessages.length,
    templateId: chat.templateId,
    provider: resolvedProviderKey,
    modelType: options.modelType || 'medium',
    chatHistoryLength: chatHistory.length - 1,
    memoryContextLength: memoryContext.length,
    memoriesRetrieved: relevantMemories.length
  });

  // Execute the prompt. API providers use the structured messages array and
  // system prompt; CLI providers ignore them and fall back to the compiled
  // plaintext prompt.
  const result = await executePrompt(chat.templateId, variableValues, {
    ...options,
    providerOverride,
    generationOptions: {
      ...options.generationOptions,
      // Copy so providers that mutate the array (openai unshifts a system
      // message) don't pollute the version kept for debug/logging
      ...(useStructured && {
        messages: structuredMessages.map(m => ({ ...m })),
        ...(systemPrompt && { systemPrompt })
      })
    }
  });

  if (!result.success) {
    // Log failed response
    chatService.logTurnResponse(chatId, turnNumber, {
      timestamp: new Date().toISOString(),
      success: false,
      error: result.error,
      provider: result.provider,
      duration: result.duration
    });
    return result;
  }

  // Build debug info if requested
  const debugInfo = options.debug ? {
    compiledPrompt: buildResult.prompt,
    systemPrompt: systemPrompt || null,
    structuredMessages,
    memoryContext: memoryContext || null,
    memoriesRetrieved: relevantMemories.map(m => ({
      content: m.content,
      category: m.category,
      importance: m.importance,
      score: m.score
    })),
    chatHistoryUsed: chatHistory.slice(0, -1),
    templateId: chat.templateId,
    variableValues: Object.keys(variableValues).reduce((acc, key) => {
      // Truncate long values for debug display
      const val = variableValues[key];
      if (typeof val === 'string' && val.length > 200) {
        acc[key] = val.slice(0, 200) + '... (truncated)';
      } else if (Array.isArray(val)) {
        acc[key] = `[${val.length} items]`;
      } else {
        acc[key] = val;
      }
      return acc;
    }, {})
  } : null;

  // Process response to extract memories and get cleaned content (skip if memory disabled)
  let cleanedContent = result.content;
  let memoriesExtracted = 0;

  if (useMemory) {
    const extracted = await memoryExtractor.processResponse(
      result.content,
      {
        chatId,
        templateId: chat.templateId,
        userMessage
      }
    );
    cleanedContent = extracted.response;
    memoriesExtracted = extracted.memoriesExtracted;
  }

  // Log turn response
  chatService.logTurnResponse(chatId, turnNumber, {
    timestamp: new Date().toISOString(),
    success: true,
    rawContent: result.content,
    cleanedContent,
    provider: result.provider,
    model: result.model,
    duration: result.duration,
    usage: result.usage
  });

  // Log turn memory info
  chatService.logTurnMemory(chatId, turnNumber, {
    timestamp: new Date().toISOString(),
    retrieved: relevantMemories.map(m => ({
      id: m.id,
      content: m.content,
      category: m.category,
      importance: m.importance,
      score: m.score
    })),
    created: memoriesExtracted,
    memoryContextUsed: memoryContext || null
  });

  // Add assistant response to chat (with cleaned content)
  const messageResult = chatService.addMessage(chatId, {
    role: 'assistant',
    content: cleanedContent,
    metadata: {
      provider: result.provider,
      model: result.model,
      duration: result.duration,
      memoriesUsed: relevantMemories.length,
      memoriesCreated: memoriesExtracted,
      ...(debugInfo && { debug: debugInfo })
    }
  });

  return {
    success: true,
    content: cleanedContent,
    provider: result.provider,
    model: result.model,
    duration: result.duration,
    memoriesUsed: relevantMemories.length,
    memoriesCreated: memoriesExtracted,
    chat: messageResult.chat,
    ...(debugInfo && { debug: debugInfo })
  };
}

/**
 * Test a template with sample values (dry run)
 */
async function testTemplate(templateId, sampleValues = {}, options = {}) {
  const template = promptService.getTemplate(templateId);
  if (!template) {
    return { success: false, error: `Template "${templateId}" not found` };
  }

  // Build the prompt without executing
  const buildResult = promptService.buildPrompt(templateId, sampleValues);
  if (!buildResult.success) {
    return buildResult;
  }

  // Optionally execute if requested
  if (options.execute) {
    return executePrompt(templateId, sampleValues, options);
  }

  // Just return the built prompt
  return {
    success: true,
    prompt: buildResult.prompt,
    template: {
      id: template.id,
      name: template.name
    },
    resolvedValues: buildResult.resolvedValues
  };
}

/**
 * Get available providers for UI dropdown
 */
function getAvailableProviders() {
  const { providers, activeProvider } = aiProvider.getProviders();

  const available = [];
  for (const [key, config] of Object.entries(providers)) {
    if (config.enabled) {
      available.push({
        key,
        name: config.name,
        active: key === activeProvider,
        models: config.models
      });
    }
  }

  return available;
}

/**
 * Initialize prompt executor
 */
function initialize() {
  promptService.initialize();
  chatService.initialize();
  console.log(`🎯 Prompt executor initialized`);
}

module.exports = {
  initialize,
  executePrompt,
  executeChat,
  testTemplate,
  resolveProvider,
  getAvailableProviders
};

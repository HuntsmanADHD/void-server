/**
 * Chat Service
 * Manages chat sessions and message persistence
 *
 * Schema v2: Tree-based messages with branching support
 * - Messages stored as object { [id]: msg } for O(1) lookup
 * - Each message has parentId forming a tree structure
 * - Branches track fork points and tips (leaf nodes)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHATS_DIR = path.resolve(__dirname, '../../data/chats');
const LEGACY_CHATS_DIR = path.resolve(__dirname, '../../config/prompts/chats');

const CURRENT_SCHEMA_VERSION = 2;

/**
 * Ensure chats directory exists
 */
function ensureChatsDir() {
  if (!fs.existsSync(CHATS_DIR)) {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
  }
}

/**
 * Generate a unique chat ID
 */
function generateChatId() {
  return crypto.randomUUID();
}

/**
 * Generate a unique message ID
 */
function generateMessageId() {
  return `msg-${crypto.randomUUID()}`;
}

/**
 * Generate a unique branch ID
 */
function generateBranchId() {
  return `branch-${crypto.randomUUID()}`;
}

/**
 * Get chat folder path (new structure)
 */
function getChatDir(chatId) {
  return path.join(CHATS_DIR, chatId);
}

/**
 * Get chat.json file path within chat folder
 */
function getChatPath(chatId) {
  return path.join(getChatDir(chatId), 'chat.json');
}

/**
 * Get turns directory for a chat
 */
function getTurnsDir(chatId) {
  return path.join(getChatDir(chatId), 'turns');
}

/**
 * Get turn directory path (padded number)
 */
function getTurnDir(chatId, turnNumber) {
  const padded = String(turnNumber).padStart(4, '0');
  return path.join(getTurnsDir(chatId), padded);
}

/**
 * Ensure chat folder structure exists
 */
function ensureChatDir(chatId) {
  const chatDir = getChatDir(chatId);
  if (!fs.existsSync(chatDir)) {
    fs.mkdirSync(chatDir, { recursive: true });
  }
  const turnsDir = getTurnsDir(chatId);
  if (!fs.existsSync(turnsDir)) {
    fs.mkdirSync(turnsDir, { recursive: true });
  }
}

/**
 * Check if chat exists (supports both old and new formats)
 */
function chatExists(chatId) {
  // New format: folder with chat.json
  if (fs.existsSync(getChatPath(chatId))) {
    return true;
  }
  // Old format: single JSON file
  const legacyPath = path.join(CHATS_DIR, `${chatId}.json`);
  return fs.existsSync(legacyPath);
}

/**
 * Migrate a single chat from old format to new format
 */
function migrateChatToFolder(chatId) {
  const legacyPath = path.join(CHATS_DIR, `${chatId}.json`);
  if (!fs.existsSync(legacyPath)) {
    return false;
  }

  // Read old format
  const data = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));

  // Create new folder structure
  ensureChatDir(chatId);

  // Write to new location
  fs.writeFileSync(getChatPath(chatId), JSON.stringify(data, null, 2));

  // Remove old file
  fs.unlinkSync(legacyPath);

  console.log(`📦 Migrated chat ${chatId} to folder format`);
  return true;
}

// ============================================================================
// Schema v2 Migration (Tree Structure)
// ============================================================================

/**
 * Migrate a chat from v1 (linear array) to v2 (tree structure)
 */
function migrateToTreeStructure(chat) {
  // Already migrated
  if (chat.schemaVersion === CURRENT_SCHEMA_VERSION) {
    return chat;
  }

  console.log(`🌳 Migrating chat "${chat.title}" to tree structure...`);

  // Convert messages array to object with IDs
  const messagesObj = {};
  let prevId = null;

  for (const msg of chat.messages || []) {
    const id = generateMessageId();
    messagesObj[id] = {
      id,
      parentId: prevId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      // Preserve any metadata (provider, model, duration, etc.)
      ...(msg.provider && { provider: msg.provider }),
      ...(msg.model && { model: msg.model }),
      ...(msg.duration && { duration: msg.duration }),
      ...(msg.debug && { debug: msg.debug })
    };
    prevId = id;
  }

  // Create default main branch
  const mainBranchId = 'branch-main';
  const branches = [{
    id: mainBranchId,
    name: 'Main',
    createdAt: chat.createdAt,
    forkPointMessageId: null, // null for main branch
    tipMessageId: prevId, // Last message (or null if empty)
    isActive: true
  }];

  // Build migrated chat
  const migratedChat = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: chat.id,
    templateId: chat.templateId,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    providerOverride: chat.providerOverride,
    messages: messagesObj,
    branches,
    activeBranchId: mainBranchId
  };

  console.log(`✅ Migrated ${Object.keys(messagesObj).length} messages to tree structure`);
  return migratedChat;
}

// ============================================================================
// Tree Traversal Helpers
// ============================================================================

/**
 * Get the linear path from root to a specific message
 * Returns array of message IDs from root to target (inclusive)
 */
function getMessagePath(chat, messageId) {
  if (!messageId || !chat.messages[messageId]) {
    return [];
  }

  const path = [];
  let currentId = messageId;

  while (currentId) {
    path.unshift(currentId);
    currentId = chat.messages[currentId]?.parentId;
  }

  return path;
}

/**
 * Get all messages in order for a branch (from root to tip)
 */
function getBranchMessages(chat, branchId) {
  const branch = chat.branches?.find(b => b.id === branchId);
  if (!branch?.tipMessageId) {
    return [];
  }

  const msgPath = getMessagePath(chat, branch.tipMessageId);
  return msgPath.map(id => chat.messages[id]).filter(Boolean);
}

/**
 * Get all descendants of a message (children, grandchildren, etc.)
 */
function getDescendants(chat, messageId) {
  const descendants = [];
  const children = Object.values(chat.messages || {}).filter(m => m.parentId === messageId);

  for (const child of children) {
    descendants.push(child.id);
    descendants.push(...getDescendants(chat, child.id));
  }

  return descendants;
}

/**
 * Get direct children of a message
 */
function getChildren(chat, messageId) {
  return Object.values(chat.messages || {}).filter(m => m.parentId === messageId);
}

/**
 * Find all leaf nodes (messages with no children) in the tree
 */
function getLeafNodes(chat) {
  const allIds = new Set(Object.keys(chat.messages || {}));
  const parentIds = new Set(Object.values(chat.messages || {}).map(m => m.parentId).filter(Boolean));

  return [...allIds].filter(id => !parentIds.has(id));
}

/**
 * Get tree structure for visualization
 * Returns nested structure suitable for rendering
 */
function getTreeStructure(chat) {
  const messages = chat.messages || {};

  // Find root messages (no parent)
  const roots = Object.values(messages).filter(m => !m.parentId);

  function buildNode(msg) {
    const children = Object.values(messages).filter(m => m.parentId === msg.id);
    return {
      id: msg.id,
      role: msg.role,
      preview: msg.content?.substring(0, 50) + (msg.content?.length > 50 ? '...' : ''),
      timestamp: msg.timestamp,
      children: children.map(buildNode)
    };
  }

  return roots.map(buildNode);
}

// ============================================================================
// Branch Management
// ============================================================================

/**
 * Create a new branch forking from a specific message
 */
function createBranch(chatId, options = {}) {
  const chat = getChat(chatId);
  if (!chat) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  const { forkPointMessageId, name } = options;

  // Validate fork point exists (unless creating from scratch)
  if (forkPointMessageId && !chat.messages[forkPointMessageId]) {
    return { success: false, error: 'Fork point message not found' };
  }

  const branchId = generateBranchId();
  const branchNumber = chat.branches.length + 1;

  const newBranch = {
    id: branchId,
    name: name || `Branch ${branchNumber}`,
    createdAt: new Date().toISOString(),
    forkPointMessageId: forkPointMessageId || null,
    tipMessageId: forkPointMessageId || null, // Start at fork point
    isActive: false
  };

  chat.branches.push(newBranch);
  chat.updatedAt = new Date().toISOString();

  const chatPath = getChatPath(chatId);
  fs.writeFileSync(chatPath, JSON.stringify(chat, null, 2));

  console.log(`🌿 Created branch "${newBranch.name}" from message ${forkPointMessageId || 'root'}`);
  return { success: true, branch: newBranch, chat };
}

/**
 * Switch to a different branch
 */
function setActiveBranch(chatId, branchId) {
  const chat = getChat(chatId);
  if (!chat) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  const branch = chat.branches.find(b => b.id === branchId);
  if (!branch) {
    return { success: false, error: `Branch "${branchId}" not found` };
  }

  // Deactivate all, activate selected
  chat.branches.forEach(b => { b.isActive = (b.id === branchId); });
  chat.activeBranchId = branchId;
  chat.updatedAt = new Date().toISOString();

  const chatPath = getChatPath(chatId);
  fs.writeFileSync(chatPath, JSON.stringify(chat, null, 2));

  console.log(`🔀 Switched to branch "${branch.name}"`);
  return { success: true, branch, chat };
}

/**
 * Update branch metadata
 */
function updateBranch(chatId, branchId, updates) {
  const chat = getChat(chatId);
  if (!chat) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  const branchIndex = chat.branches.findIndex(b => b.id === branchId);
  if (branchIndex === -1) {
    return { success: false, error: `Branch "${branchId}" not found` };
  }

  // Only allow updating name
  if (updates.name !== undefined) {
    chat.branches[branchIndex].name = updates.name;
  }

  chat.updatedAt = new Date().toISOString();

  const chatPath = getChatPath(chatId);
  fs.writeFileSync(chatPath, JSON.stringify(chat, null, 2));

  console.log(`✏️ Updated branch "${chat.branches[branchIndex].name}"`);
  return { success: true, branch: chat.branches[branchIndex], chat };
}

/**
 * Delete a branch (and optionally its messages)
 */
function deleteBranch(chatId, branchId, deleteMessages = false) {
  const chat = getChat(chatId);
  if (!chat) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  const branchIndex = chat.branches.findIndex(b => b.id === branchId);
  if (branchIndex === -1) {
    return { success: false, error: `Branch "${branchId}" not found` };
  }

  const branch = chat.branches[branchIndex];

  // Cannot delete main branch
  if (branch.id === 'branch-main') {
    return { success: false, error: 'Cannot delete the main branch' };
  }

  // If deleting messages, remove all messages unique to this branch
  if (deleteMessages && branch.forkPointMessageId) {
    const branchPath = getMessagePath(chat, branch.tipMessageId);
    const forkIndex = branchPath.indexOf(branch.forkPointMessageId);

    // Messages after fork point belong to this branch
    const branchOnlyMessages = branchPath.slice(forkIndex + 1);

    // Only delete if no other branch uses these messages
    for (const msgId of branchOnlyMessages) {
      const usedByOther = chat.branches.some(b =>
        b.id !== branchId && getMessagePath(chat, b.tipMessageId).includes(msgId)
      );
      if (!usedByOther) {
        delete chat.messages[msgId];
      }
    }
  }

  // Remove branch
  chat.branches.splice(branchIndex, 1);

  // If deleted branch was active, switch to main
  if (chat.activeBranchId === branchId) {
    chat.activeBranchId = 'branch-main';
    const mainBranch = chat.branches.find(b => b.id === 'branch-main');
    if (mainBranch) mainBranch.isActive = true;
  }

  chat.updatedAt = new Date().toISOString();

  const chatPath = getChatPath(chatId);
  fs.writeFileSync(chatPath, JSON.stringify(chat, null, 2));

  console.log(`🗑️ Deleted branch "${branch.name}"`);
  return { success: true, message: `Deleted branch "${branch.name}"`, chat };
}

/**
 * List all branches for a chat
 */
function listBranches(chatId) {
  const chat = getChat(chatId);
  if (!chat) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  const branchesWithCounts = chat.branches.map(branch => {
    const messages = getBranchMessages(chat, branch.id);
    return {
      ...branch,
      messageCount: messages.length
    };
  });

  return { success: true, branches: branchesWithCounts };
}

// ============================================================================
// Chat CRUD
// ============================================================================

/**
 * List all chat sessions (metadata only, no messages)
 */
function listChats() {
  ensureChatsDir();

  const entries = fs.readdirSync(CHATS_DIR, { withFileTypes: true });
  const chats = [];

  for (const entry of entries) {
    let data;

    if (entry.isDirectory()) {
      // New format: folder with chat.json
      const chatJsonPath = path.join(CHATS_DIR, entry.name, 'chat.json');
      if (!fs.existsSync(chatJsonPath)) continue;
      data = JSON.parse(fs.readFileSync(chatJsonPath, 'utf8'));
    } else if (entry.name.endsWith('.json') && entry.name !== '.gitkeep') {
      // Old format: single JSON file - migrate it
      const chatId = entry.name.replace('.json', '');
      migrateChatToFolder(chatId);
      data = JSON.parse(fs.readFileSync(getChatPath(chatId), 'utf8'));
    } else {
      continue;
    }

    // Calculate message count based on schema version
    let messageCount = 0;
    if (data.schemaVersion === CURRENT_SCHEMA_VERSION) {
      // v2: messages is an object
      messageCount = Object.keys(data.messages || {}).length;
    } else {
      // v1: messages is an array
      messageCount = data.messages?.length || 0;
    }

    chats.push({
      id: data.id,
      templateId: data.templateId,
      title: data.title,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messageCount,
      providerOverride: data.providerOverride,
      branchCount: data.branches?.length || 1
    });
  }

  // Sort by updatedAt descending (most recent first)
  chats.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  return chats;
}

/**
 * Get full chat with messages (auto-migrates to v2 schema)
 */
function getChat(chatId) {
  ensureChatsDir();

  // Check for old format and migrate if needed
  const legacyPath = path.join(CHATS_DIR, `${chatId}.json`);
  if (fs.existsSync(legacyPath) && !fs.existsSync(getChatPath(chatId))) {
    migrateChatToFolder(chatId);
  }

  const chatPath = getChatPath(chatId);
  if (!fs.existsSync(chatPath)) {
    return null;
  }

  let chat = JSON.parse(fs.readFileSync(chatPath, 'utf8'));

  // Auto-migrate to v2 tree structure if needed
  if (chat.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    chat = migrateToTreeStructure(chat);
    // Persist the migrated chat
    fs.writeFileSync(chatPath, JSON.stringify(chat, null, 2));
  }

  return chat;
}

/**
 * Create a new chat session (v2 schema with tree structure)
 */
function createChat(templateId, title = null, providerOverride = null) {
  ensureChatsDir();

  const id = generateChatId();
  const now = new Date().toISOString();
  const mainBranchId = 'branch-main';

  const chat = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id,
    templateId,
    title: title || `Chat ${new Date().toLocaleDateString()}`,
    createdAt: now,
    updatedAt: now,
    providerOverride,
    messages: {},
    branches: [{
      id: mainBranchId,
      name: 'Main',
      createdAt: now,
      forkPointMessageId: null,
      tipMessageId: null,
      isActive: true
    }],
    activeBranchId: mainBranchId
  };

  // Create folder structure
  ensureChatDir(id);

  const chatPath = getChatPath(id);
  fs.writeFileSync(chatPath, JSON.stringify(chat, null, 2));

  console.log(`💬 Created chat: ${chat.title} (${id})`);
  return { success: true, chat };
}

/**
 * Update chat metadata
 */
function updateChat(chatId, updates) {
  const chat = getChat(chatId);
  if (!chat) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  // Only allow updating certain fields
  const allowedUpdates = ['title', 'templateId', 'providerOverride'];
  for (const key of allowedUpdates) {
    if (updates[key] !== undefined) {
      chat[key] = updates[key];
    }
  }

  chat.updatedAt = new Date().toISOString();

  const chatPath = getChatPath(chatId);
  fs.writeFileSync(chatPath, JSON.stringify(chat, null, 2));

  console.log(`✏️ Updated chat: ${chat.title}`);
  return { success: true, chat };
}

/**
 * Delete a chat session
 */
function deleteChat(chatId) {
  // Check for old format first
  const legacyPath = path.join(CHATS_DIR, `${chatId}.json`);
  if (fs.existsSync(legacyPath)) {
    const chat = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    fs.unlinkSync(legacyPath);
    console.log(`🗑️ Deleted chat: ${chat.title}`);
    return { success: true, message: `Deleted chat "${chat.title}"` };
  }

  // New format: folder
  const chatPath = getChatPath(chatId);
  if (!fs.existsSync(chatPath)) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  const chat = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
  const chatDir = getChatDir(chatId);

  // Remove folder recursively
  fs.rmSync(chatDir, { recursive: true, force: true });

  console.log(`🗑️ Deleted chat: ${chat.title}`);
  return { success: true, message: `Deleted chat "${chat.title}"` };
}

// ============================================================================
// Message Management
// ============================================================================

/**
 * Add a message to a chat (v2: tree structure with branch support)
 *
 * @param {string} chatId - The chat ID
 * @param {object} message - Message object with role, content, and optional metadata
 * @param {object} options - Optional: { parentId, branchId }
 *   - parentId: Explicitly set parent (otherwise uses active branch tip)
 *   - branchId: Target branch (otherwise uses active branch)
 */
function addMessage(chatId, message, options = {}) {
  const chat = getChat(chatId);
  if (!chat) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  const now = new Date().toISOString();
  const targetBranchId = options.branchId || chat.activeBranchId;
  const branch = chat.branches.find(b => b.id === targetBranchId);

  if (!branch) {
    return { success: false, error: `Branch "${targetBranchId}" not found` };
  }

  // Determine parent: explicit, or branch tip, or null (first message)
  const parentId = options.parentId !== undefined ? options.parentId : branch.tipMessageId;

  // Generate message ID
  const msgId = generateMessageId();

  const msg = {
    id: msgId,
    parentId,
    role: message.role, // 'user' or 'assistant'
    content: message.content,
    timestamp: now,
    ...message.metadata // provider, model, duration, etc.
  };

  // Add to messages object
  chat.messages[msgId] = msg;

  // Update branch tip
  branch.tipMessageId = msgId;

  chat.updatedAt = now;

  // Auto-generate title from first user message if still default
  const messageCount = Object.keys(chat.messages).length;
  if (messageCount === 1 && message.role === 'user') {
    const firstWords = message.content.split(/\s+/).slice(0, 5).join(' ');
    if (chat.title.startsWith('Chat ')) {
      chat.title = firstWords.length > 30 ? firstWords.slice(0, 30) + '...' : firstWords;
    }
  }

  const chatPath = getChatPath(chatId);
  fs.writeFileSync(chatPath, JSON.stringify(chat, null, 2));

  return { success: true, message: msg, chat };
}

/**
 * Get messages from a chat for a specific branch
 * Returns linear message array from root to branch tip
 */
function getMessages(chatId, options = {}) {
  const chat = getChat(chatId);
  if (!chat) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  const { limit, offset = 0, branchId } = options;
  const targetBranchId = branchId || chat.activeBranchId;

  // Get messages for the branch (linear path from root to tip)
  let messages = getBranchMessages(chat, targetBranchId);

  if (offset > 0) {
    messages = messages.slice(offset);
  }

  if (limit) {
    messages = messages.slice(0, limit);
  }

  return {
    success: true,
    messages,
    total: getBranchMessages(chat, targetBranchId).length,
    branchId: targetBranchId
  };
}

/**
 * Clear all messages in a chat (resets all branches to empty)
 */
function clearMessages(chatId) {
  const chat = getChat(chatId);
  if (!chat) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  // Reset to empty state
  chat.messages = {};
  chat.branches = [{
    id: 'branch-main',
    name: 'Main',
    createdAt: chat.createdAt,
    forkPointMessageId: null,
    tipMessageId: null,
    isActive: true
  }];
  chat.activeBranchId = 'branch-main';
  chat.updatedAt = new Date().toISOString();

  const chatPath = getChatPath(chatId);
  fs.writeFileSync(chatPath, JSON.stringify(chat, null, 2));

  console.log(`🧹 Cleared messages in chat: ${chat.title}`);
  return { success: true, message: `Cleared messages in "${chat.title}"` };
}

/**
 * Get chat history formatted for prompt injection (branch-aware)
 * Returns array of formatted messages for the active branch
 */
function getChatHistory(chatId, maxMessages = 20, branchId = null) {
  const chat = getChat(chatId);
  if (!chat) {
    return [];
  }

  const targetBranchId = branchId || chat.activeBranchId;
  const branchMessages = getBranchMessages(chat, targetBranchId);

  // Get last N messages from the branch
  const recentMessages = branchMessages.slice(-maxMessages);

  return recentMessages.map(msg => {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    return `${role}: ${msg.content}`;
  });
}

/**
 * Get chat history as structured messages for chat-completion APIs (branch-aware)
 * Returns array of { role: 'user'|'assistant', content } in chronological order
 */
function getChatMessages(chatId, maxMessages = 20, branchId = null) {
  const chat = getChat(chatId);
  if (!chat) {
    return [];
  }

  const targetBranchId = branchId || chat.activeBranchId;
  const branchMessages = getBranchMessages(chat, targetBranchId);

  return branchMessages.slice(-maxMessages).map(msg => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.content
  }));
}

/**
 * Export chat to different formats (branch-aware)
 */
function exportChat(chatId, format = 'json', branchId = null) {
  const chat = getChat(chatId);
  if (!chat) {
    return { success: false, error: `Chat "${chatId}" not found` };
  }

  const targetBranchId = branchId || chat.activeBranchId;
  const branch = chat.branches.find(b => b.id === targetBranchId);
  const branchMessages = getBranchMessages(chat, targetBranchId);

  if (format === 'markdown') {
    let md = `# ${chat.title}\n\n`;
    md += `Template: ${chat.templateId}\n`;
    md += `Created: ${chat.createdAt}\n`;
    md += `Branch: ${branch?.name || 'Main'} (${branchMessages.length} messages)\n\n`;
    md += `---\n\n`;

    for (const msg of branchMessages) {
      const role = msg.role === 'user' ? '**User**' : '**Assistant**';
      md += `${role}:\n\n${msg.content}\n\n`;
    }

    return { success: true, format: 'markdown', content: md };
  }

  // Default: JSON (full chat including all branches)
  return { success: true, format: 'json', content: JSON.stringify(chat, null, 2) };
}

// ============================================================================
// Turn Logging (Debug Info)
// ============================================================================

/**
 * Get the current turn number for a chat (branch-aware)
 */
function getCurrentTurnNumber(chatId, branchId = null) {
  const chat = getChat(chatId);
  if (!chat) return 0;

  // Get messages for the active branch
  const targetBranchId = branchId || chat.activeBranchId;
  const branchMsgs = getBranchMessages(chat, targetBranchId);

  // Each user+assistant pair is one turn
  const userMessages = branchMsgs.filter(m => m.role === 'user');
  return userMessages.length;
}

/**
 * Log turn request (what was sent to the AI)
 */
function logTurnRequest(chatId, turnNumber, data) {
  ensureChatDir(chatId);
  const turnDir = getTurnDir(chatId, turnNumber);

  if (!fs.existsSync(turnDir)) {
    fs.mkdirSync(turnDir, { recursive: true });
  }

  const requestPath = path.join(turnDir, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(data, null, 2));
}

/**
 * Log turn response (what the AI returned)
 */
function logTurnResponse(chatId, turnNumber, data) {
  ensureChatDir(chatId);
  const turnDir = getTurnDir(chatId, turnNumber);

  if (!fs.existsSync(turnDir)) {
    fs.mkdirSync(turnDir, { recursive: true });
  }

  const responsePath = path.join(turnDir, 'response.json');
  fs.writeFileSync(responsePath, JSON.stringify(data, null, 2));
}

/**
 * Log turn memory info (memories used and created)
 */
function logTurnMemory(chatId, turnNumber, data) {
  ensureChatDir(chatId);
  const turnDir = getTurnDir(chatId, turnNumber);

  if (!fs.existsSync(turnDir)) {
    fs.mkdirSync(turnDir, { recursive: true });
  }

  const memoryPath = path.join(turnDir, 'memory.json');
  fs.writeFileSync(memoryPath, JSON.stringify(data, null, 2));
}

/**
 * Log a complete turn (convenience function)
 */
function logTurn(chatId, turnNumber, { request, response, memory }) {
  if (request) logTurnRequest(chatId, turnNumber, request);
  if (response) logTurnResponse(chatId, turnNumber, response);
  if (memory) logTurnMemory(chatId, turnNumber, memory);
}

/**
 * Get turn logs for a specific turn
 */
function getTurnLogs(chatId, turnNumber) {
  const turnDir = getTurnDir(chatId, turnNumber);

  if (!fs.existsSync(turnDir)) {
    return null;
  }

  const logs = {};

  const requestPath = path.join(turnDir, 'request.json');
  if (fs.existsSync(requestPath)) {
    logs.request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  }

  const responsePath = path.join(turnDir, 'response.json');
  if (fs.existsSync(responsePath)) {
    logs.response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
  }

  const memoryPath = path.join(turnDir, 'memory.json');
  if (fs.existsSync(memoryPath)) {
    logs.memory = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
  }

  return logs;
}

/**
 * List all turn numbers for a chat
 */
function listTurns(chatId) {
  const turnsDir = getTurnsDir(chatId);

  if (!fs.existsSync(turnsDir)) {
    return [];
  }

  return fs.readdirSync(turnsDir)
    .filter(f => fs.statSync(path.join(turnsDir, f)).isDirectory())
    .map(f => parseInt(f, 10))
    .sort((a, b) => a - b);
}

/**
 * Migrate chats from legacy location (config/prompts/chats) to new location (data/chats)
 */
function migrateFromLegacy() {
  if (!fs.existsSync(LEGACY_CHATS_DIR)) {
    return 0;
  }

  const legacyFiles = fs.readdirSync(LEGACY_CHATS_DIR).filter(f => f.endsWith('.json'));
  if (legacyFiles.length === 0) {
    return 0;
  }

  let migrated = 0;
  for (const file of legacyFiles) {
    const legacyPath = path.join(LEGACY_CHATS_DIR, file);
    const newPath = path.join(CHATS_DIR, file);

    // Skip if already exists in new location
    if (fs.existsSync(newPath)) {
      continue;
    }

    // Copy to new location
    const data = fs.readFileSync(legacyPath, 'utf8');
    fs.writeFileSync(newPath, data);
    migrated++;

    // Remove from legacy location
    fs.unlinkSync(legacyPath);
  }

  return migrated;
}

/**
 * Initialize chat service
 */
function initialize() {
  ensureChatsDir();

  // Migrate from legacy location if needed
  const migrated = migrateFromLegacy();
  if (migrated > 0) {
    console.log(`📦 Migrated ${migrated} chat(s) from config/prompts/chats to data/chats`);
  }

  const chats = listChats();
  console.log(`💬 Chat service initialized (${chats.length} chats)`);
}

module.exports = {
  initialize,
  listChats,
  getChat,
  createChat,
  updateChat,
  deleteChat,
  addMessage,
  getMessages,
  clearMessages,
  getChatHistory,
  getChatMessages,
  exportChat,
  // Branch management
  createBranch,
  setActiveBranch,
  updateBranch,
  deleteBranch,
  listBranches,
  getBranchMessages,
  // Tree traversal
  getMessagePath,
  getDescendants,
  getChildren,
  getLeafNodes,
  getTreeStructure,
  // Turn logging
  getCurrentTurnNumber,
  logTurnRequest,
  logTurnResponse,
  logTurnMemory,
  logTurn,
  getTurnLogs,
  listTurns
};

/**
 * Chat REST API Routes
 * Manages chat sessions and messages
 */

const express = require('express');
const router = express.Router();
const chatService = require('../services/chat-service');
const promptExecutor = require('../services/prompt-executor');

// ============================================================================
// Chat Session Routes
// ============================================================================

/**
 * GET /api/chat
 * List all chat sessions
 */
router.get('/', (req, res) => {
  const chats = chatService.listChats();
  res.json({ success: true, chats });
});

/**
 * GET /api/chat/:id
 * Get a chat session with messages
 */
router.get('/:id', (req, res) => {
  const chat = chatService.getChat(req.params.id);

  if (!chat) {
    return res.status(404).json({ success: false, error: 'Chat not found' });
  }

  res.json({ success: true, chat });
});

/**
 * POST /api/chat
 * Create a new chat session
 */
router.post('/', (req, res) => {
  const { templateId, title, providerOverride } = req.body;

  if (!templateId) {
    return res.status(400).json({ success: false, error: 'templateId required' });
  }

  const result = chatService.createChat(templateId, title, providerOverride);

  if (!result.success) {
    return res.status(400).json(result);
  }

  res.status(201).json(result);
});

/**
 * PUT /api/chat/:id
 * Update chat metadata
 */
router.put('/:id', (req, res) => {
  const result = chatService.updateChat(req.params.id, req.body);

  if (!result.success) {
    return res.status(404).json(result);
  }

  res.json(result);
});

/**
 * DELETE /api/chat/:id
 * Delete a chat session
 */
router.delete('/:id', (req, res) => {
  const result = chatService.deleteChat(req.params.id);

  if (!result.success) {
    return res.status(404).json(result);
  }

  res.json(result);
});

// ============================================================================
// Message Routes
// ============================================================================

/**
 * POST /api/chat/:id/message
 * Send a message and get a response
 */
router.post('/:id/message', async (req, res) => {
  const { content, providerOverride, modelType, maxHistory, debug, useMemory } = req.body;

  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ success: false, error: 'Message content required' });
  }

  const result = await promptExecutor.executeChat(req.params.id, content, {
    providerOverride,
    modelType,
    maxHistory,
    debug: debug === true,
    useMemory: useMemory !== false // Default to true
  });

  if (!result.success) {
    return res.status(result.error?.includes('not found') ? 404 : 500).json(result);
  }

  res.json(result);
});

/**
 * GET /api/chat/:id/messages
 * Get messages with optional pagination
 */
router.get('/:id/messages', (req, res) => {
  const { limit, offset } = req.query;

  const result = chatService.getMessages(req.params.id, {
    limit: limit ? parseInt(limit) : undefined,
    offset: offset ? parseInt(offset) : 0
  });

  if (!result.success) {
    return res.status(404).json(result);
  }

  res.json(result);
});

/**
 * DELETE /api/chat/:id/messages
 * Clear all messages in a chat
 */
router.delete('/:id/messages', (req, res) => {
  const result = chatService.clearMessages(req.params.id);

  if (!result.success) {
    return res.status(404).json(result);
  }

  res.json(result);
});

// ============================================================================
// Branch Routes (Conversation Loom)
// ============================================================================

/**
 * GET /api/chat/:id/branches
 * List all branches for a chat
 */
router.get('/:id/branches', (req, res) => {
  const result = chatService.listBranches(req.params.id);

  if (!result.success) {
    return res.status(404).json(result);
  }

  res.json(result);
});

/**
 * GET /api/chat/:id/tree
 * Get tree structure for visualization
 */
router.get('/:id/tree', (req, res) => {
  const chat = chatService.getChat(req.params.id);

  if (!chat) {
    return res.status(404).json({ success: false, error: 'Chat not found' });
  }

  const tree = chatService.getTreeStructure(chat);
  res.json({
    success: true,
    tree,
    branches: chat.branches,
    activeBranchId: chat.activeBranchId
  });
});

/**
 * POST /api/chat/:id/branch
 * Create a new branch from a message
 */
router.post('/:id/branch', (req, res) => {
  const { forkPointMessageId, name } = req.body;

  const result = chatService.createBranch(req.params.id, {
    forkPointMessageId,
    name
  });

  if (!result.success) {
    return res.status(result.error?.includes('not found') ? 404 : 400).json(result);
  }

  res.status(201).json(result);
});

/**
 * GET /api/chat/:id/branch/:branchId/messages
 * Get messages for a specific branch
 */
router.get('/:id/branch/:branchId/messages', (req, res) => {
  const { limit, offset } = req.query;

  const result = chatService.getMessages(req.params.id, {
    branchId: req.params.branchId,
    limit: limit ? parseInt(limit) : undefined,
    offset: offset ? parseInt(offset) : 0
  });

  if (!result.success) {
    return res.status(404).json(result);
  }

  res.json(result);
});

/**
 * PUT /api/chat/:id/branch/:branchId
 * Update branch metadata or switch to branch
 */
router.put('/:id/branch/:branchId', (req, res) => {
  const { name, setActive } = req.body;

  // If setActive is true, switch to this branch
  if (setActive) {
    const result = chatService.setActiveBranch(req.params.id, req.params.branchId);
    if (!result.success) {
      return res.status(404).json(result);
    }
    return res.json(result);
  }

  // Otherwise, update branch metadata
  const result = chatService.updateBranch(req.params.id, req.params.branchId, { name });

  if (!result.success) {
    return res.status(404).json(result);
  }

  res.json(result);
});

/**
 * DELETE /api/chat/:id/branch/:branchId
 * Delete a branch
 */
router.delete('/:id/branch/:branchId', (req, res) => {
  const deleteMessages = req.query.deleteMessages === 'true';

  const result = chatService.deleteBranch(req.params.id, req.params.branchId, deleteMessages);

  if (!result.success) {
    return res.status(result.error?.includes('Cannot delete') ? 400 : 404).json(result);
  }

  res.json(result);
});

// ============================================================================
// Export Routes
// ============================================================================

/**
 * GET /api/chat/:id/export
 * Export chat to different formats
 */
router.get('/:id/export', (req, res) => {
  const { format, branchId } = req.query;

  const result = chatService.exportChat(req.params.id, format || 'json', branchId);

  if (!result.success) {
    return res.status(404).json(result);
  }

  // Set appropriate content type
  if (result.format === 'markdown') {
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="chat-${req.params.id}.md"`);
    return res.send(result.content);
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="chat-${req.params.id}.json"`);
  res.send(result.content);
});

module.exports = router;

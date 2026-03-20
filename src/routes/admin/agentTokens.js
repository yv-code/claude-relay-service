const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const agentTokenService = require('../../services/agentTokenService')
const logger = require('../../utils/logger')

const router = express.Router()

// 📋 获取所有 Agent Token
router.get('/agent-tokens', authenticateAdmin, async (req, res) => {
  try {
    const tokens = await agentTokenService.getAllTokens()
    return res.json({ success: true, data: tokens })
  } catch (error) {
    logger.error('Failed to get agent tokens:', error)
    return res.status(500).json({ error: 'Failed to get agent tokens', message: error.message })
  }
})

// 🔑 创建 Agent Token
router.post('/agent-tokens', authenticateAdmin, async (req, res) => {
  try {
    const { name, description, expiresAt } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Token name is required' })
    }

    const result = await agentTokenService.generateToken({
      name,
      description,
      expiresAt,
      createdBy: req.admin?.username || 'admin'
    })

    return res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Failed to create agent token:', error)
    return res.status(500).json({ error: 'Failed to create agent token', message: error.message })
  }
})

// ✏️ 更新 Agent Token
router.put('/agent-tokens/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const { name, description, isActive, expiresAt } = req.body

    const result = await agentTokenService.updateToken(id, {
      name,
      description,
      isActive,
      expiresAt
    })

    return res.json({ success: true, data: result })
  } catch (error) {
    if (error.message === 'Token not found') {
      return res.status(404).json({ error: 'Token not found' })
    }
    logger.error('Failed to update agent token:', error)
    return res.status(500).json({ error: 'Failed to update agent token', message: error.message })
  }
})

// 🗑️ 删除 Agent Token
router.delete('/agent-tokens/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    await agentTokenService.deleteToken(id)
    return res.json({ success: true, message: 'Token deleted successfully' })
  } catch (error) {
    if (error.message === 'Token not found') {
      return res.status(404).json({ error: 'Token not found' })
    }
    logger.error('Failed to delete agent token:', error)
    return res.status(500).json({ error: 'Failed to delete agent token', message: error.message })
  }
})

// 🔄 重新生成 Agent Token
router.post('/agent-tokens/:id/regenerate', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const result = await agentTokenService.regenerateToken(id)
    return res.json({ success: true, data: result })
  } catch (error) {
    if (error.message === 'Token not found') {
      return res.status(404).json({ error: 'Token not found' })
    }
    logger.error('Failed to regenerate agent token:', error)
    return res
      .status(500)
      .json({ error: 'Failed to regenerate agent token', message: error.message })
  }
})

module.exports = router

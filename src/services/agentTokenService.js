const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const config = require('../../config/config')
const redis = require('../models/redis')
const logger = require('../utils/logger')

const TOKEN_PREFIX = 'ag_'
const HASH_MAP_KEY = 'agent_token:hash_map'

class AgentTokenService {
  // 🔐 生成密钥
  _generateSecret() {
    return crypto.randomBytes(32).toString('hex')
  }

  // 🔒 哈希 Token
  _hashToken(token) {
    return crypto
      .createHash('sha256')
      .update(token + config.security.encryptionKey)
      .digest('hex')
  }

  // 🔑 生成新的 Agent Token
  async generateToken({ name, description = '', expiresAt = '', createdBy = 'admin' }) {
    if (!name || !name.trim()) {
      throw new Error('Token name is required')
    }

    const tokenId = uuidv4()
    const plainToken = `${TOKEN_PREFIX}${this._generateSecret()}`
    const hashedToken = this._hashToken(plainToken)

    const tokenData = {
      id: tokenId,
      name: name.trim(),
      description: description || '',
      hashedToken,
      isActive: 'true',
      expiresAt: expiresAt || '',
      createdAt: new Date().toISOString(),
      createdBy,
      lastUsedAt: ''
    }

    const client = redis.getClient()
    const redisKey = `agent_token:${tokenId}`

    await client.hset(redisKey, tokenData)
    await client.hset(HASH_MAP_KEY, hashedToken, tokenId)

    logger.success(`🔑 Generated new agent token: ${name} (${tokenId})`)

    return {
      id: tokenId,
      token: plainToken,
      name: tokenData.name,
      description: tokenData.description,
      isActive: true,
      expiresAt: tokenData.expiresAt,
      createdAt: tokenData.createdAt,
      createdBy: tokenData.createdBy
    }
  }

  // 🔍 验证 Agent Token
  async validateToken(plainToken) {
    try {
      if (!plainToken || !plainToken.startsWith(TOKEN_PREFIX)) {
        return { valid: false, error: 'Invalid token format' }
      }

      const hashedToken = this._hashToken(plainToken)
      const client = redis.getClient()

      const tokenId = await client.hget(HASH_MAP_KEY, hashedToken)
      if (!tokenId) {
        return { valid: false, error: 'Token not found' }
      }

      const tokenData = await client.hgetall(`agent_token:${tokenId}`)
      if (!tokenData || !tokenData.id) {
        return { valid: false, error: 'Token data not found' }
      }

      if (tokenData.isActive !== 'true') {
        return { valid: false, error: 'Token is disabled' }
      }

      if (tokenData.expiresAt) {
        const expiresAt = new Date(tokenData.expiresAt)
        if (expiresAt <= new Date()) {
          return { valid: false, error: 'Token has expired' }
        }
      }

      // 更新最后使用时间（fire-and-forget）
      client
        .hset(`agent_token:${tokenId}`, 'lastUsedAt', new Date().toISOString())
        .catch((e) => logger.warn('Failed to update agent token lastUsedAt:', e.message))

      return { valid: true, tokenData }
    } catch (error) {
      logger.error('Agent token validation error:', error)
      return { valid: false, error: 'Validation error' }
    }
  }

  // 📋 获取所有 Token（不含敏感信息）
  async getAllTokens() {
    const client = redis.getClient()
    const keys = await this._scanTokenKeys(client)
    const tokens = []

    for (const key of keys) {
      const data = await client.hgetall(key)
      if (data && data.id) {
        tokens.push(this._sanitizeToken(data))
      }
    }

    // 按创建时间降序排序
    tokens.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    return tokens
  }

  // 📄 获取单个 Token
  async getToken(tokenId) {
    const client = redis.getClient()
    const data = await client.hgetall(`agent_token:${tokenId}`)
    if (!data || !data.id) {
      return null
    }
    return this._sanitizeToken(data)
  }

  // ✏️ 更新 Token
  async updateToken(tokenId, updates) {
    const client = redis.getClient()
    const redisKey = `agent_token:${tokenId}`
    const existing = await client.hgetall(redisKey)

    if (!existing || !existing.id) {
      throw new Error('Token not found')
    }

    const allowedFields = ['name', 'description', 'isActive', 'expiresAt']
    const updateData = {}

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        if (field === 'isActive') {
          updateData[field] = String(updates[field])
        } else if (field === 'name') {
          if (!updates[field] || !updates[field].trim()) {
            throw new Error('Token name cannot be empty')
          }
          updateData[field] = updates[field].trim()
        } else {
          updateData[field] = updates[field] ?? ''
        }
      }
    }

    if (Object.keys(updateData).length > 0) {
      await client.hset(redisKey, updateData)
    }

    logger.info(`✏️ Updated agent token: ${existing.name} (${tokenId})`)
    return await this.getToken(tokenId)
  }

  // 🗑️ 删除 Token
  async deleteToken(tokenId) {
    const client = redis.getClient()
    const redisKey = `agent_token:${tokenId}`
    const existing = await client.hgetall(redisKey)

    if (!existing || !existing.id) {
      throw new Error('Token not found')
    }

    // 从 hash map 中移除
    if (existing.hashedToken) {
      await client.hdel(HASH_MAP_KEY, existing.hashedToken)
    }

    await client.del(redisKey)
    logger.info(`🗑️ Deleted agent token: ${existing.name} (${tokenId})`)
  }

  // 🔄 重新生成 Token 密钥
  async regenerateToken(tokenId) {
    const client = redis.getClient()
    const redisKey = `agent_token:${tokenId}`
    const existing = await client.hgetall(redisKey)

    if (!existing || !existing.id) {
      throw new Error('Token not found')
    }

    // 移除旧的 hash 映射
    if (existing.hashedToken) {
      await client.hdel(HASH_MAP_KEY, existing.hashedToken)
    }

    // 生成新密钥
    const plainToken = `${TOKEN_PREFIX}${this._generateSecret()}`
    const hashedToken = this._hashToken(plainToken)

    await client.hset(redisKey, { hashedToken })
    await client.hset(HASH_MAP_KEY, hashedToken, tokenId)

    logger.info(`🔄 Regenerated agent token: ${existing.name} (${tokenId})`)

    return {
      id: tokenId,
      token: plainToken,
      name: existing.name
    }
  }

  // 内部：扫描所有 agent_token 键（排除 hash_map）
  async _scanTokenKeys(client) {
    const keys = []
    let cursor = '0'

    do {
      const [nextCursor, batch] = await client.scan(cursor, 'MATCH', 'agent_token:*', 'COUNT', 100)
      cursor = nextCursor
      for (const key of batch) {
        if (key !== HASH_MAP_KEY) {
          keys.push(key)
        }
      }
    } while (cursor !== '0')

    return keys
  }

  // 内部：移除敏感字段
  _sanitizeToken(data) {
    return {
      id: data.id,
      name: data.name,
      description: data.description || '',
      isActive: data.isActive === 'true',
      expiresAt: data.expiresAt || '',
      createdAt: data.createdAt,
      createdBy: data.createdBy || '',
      lastUsedAt: data.lastUsedAt || ''
    }
  }
}

module.exports = new AgentTokenService()

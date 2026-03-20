const crypto = require('crypto')

// Mock dependencies
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

const ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!'

jest.mock(
  '../config/config',
  () => ({
    security: { encryptionKey: ENCRYPTION_KEY }
  }),
  { virtual: true }
)

// Build mock Redis client
const mockClient = {
  hset: jest.fn().mockResolvedValue('OK'),
  hgetall: jest.fn().mockResolvedValue(null),
  hget: jest.fn().mockResolvedValue(null),
  hdel: jest.fn().mockResolvedValue(1),
  del: jest.fn().mockResolvedValue(1),
  scan: jest.fn().mockResolvedValue(['0', []])
}

jest.mock('../src/models/redis', () => ({
  getClient: () => mockClient
}))

// Require AFTER mocks
const agentTokenService = require('../src/services/agentTokenService')

describe('AgentTokenService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockClient.hset.mockResolvedValue('OK')
    mockClient.hgetall.mockResolvedValue(null)
    mockClient.hget.mockResolvedValue(null)
    mockClient.hdel.mockResolvedValue(1)
    mockClient.del.mockResolvedValue(1)
    mockClient.scan.mockResolvedValue(['0', []])
  })

  describe('generateToken', () => {
    it('should generate a token with ag_ prefix', async () => {
      const result = await agentTokenService.generateToken({
        name: 'Test Token',
        description: 'A test token',
        createdBy: 'admin'
      })

      expect(result.token).toMatch(/^ag_[a-f0-9]{64}$/)
      expect(result.id).toBeDefined()
      expect(result.name).toBe('Test Token')
      expect(result.description).toBe('A test token')
      expect(result.isActive).toBe(true)
      expect(result.createdBy).toBe('admin')
    })

    it('should store hashed token in Redis', async () => {
      await agentTokenService.generateToken({
        name: 'Test Token',
        createdBy: 'admin'
      })

      // Should store token data
      expect(mockClient.hset).toHaveBeenCalledTimes(2)
      // First call: token data hash
      const tokenDataCall = mockClient.hset.mock.calls[0]
      expect(tokenDataCall[0]).toMatch(/^agent_token:/)
      expect(tokenDataCall[1]).toHaveProperty('name', 'Test Token')
      expect(tokenDataCall[1]).toHaveProperty('isActive', 'true')
      expect(tokenDataCall[1]).toHaveProperty('hashedToken')
      // Should NOT contain plaintext
      expect(tokenDataCall[1].hashedToken).not.toMatch(/^ag_/)

      // Second call: hash map entry
      const hashMapCall = mockClient.hset.mock.calls[1]
      expect(hashMapCall[0]).toBe('agent_token:hash_map')
    })

    it('should throw if name is empty', async () => {
      await expect(
        agentTokenService.generateToken({ name: '', createdBy: 'admin' })
      ).rejects.toThrow('Token name is required')

      await expect(
        agentTokenService.generateToken({ name: '   ', createdBy: 'admin' })
      ).rejects.toThrow('Token name is required')
    })

    it('should set expiresAt when provided', async () => {
      const expiresAt = '2030-12-31T00:00:00Z'
      const result = await agentTokenService.generateToken({
        name: 'Expiring Token',
        expiresAt,
        createdBy: 'admin'
      })

      expect(result.expiresAt).toBe(expiresAt)
      const tokenDataCall = mockClient.hset.mock.calls[0]
      expect(tokenDataCall[1]).toHaveProperty('expiresAt', expiresAt)
    })

    it('should set expiresAt to empty string when not provided', async () => {
      const result = await agentTokenService.generateToken({
        name: 'No Expiry Token',
        createdBy: 'admin'
      })

      expect(result.expiresAt).toBe('')
    })
  })

  describe('validateToken', () => {
    const makePlainToken = () => {
      const secret = crypto.randomBytes(32).toString('hex')
      return `ag_${secret}`
    }

    const hashToken = (token) => {
      return crypto
        .createHash('sha256')
        .update(token + ENCRYPTION_KEY)
        .digest('hex')
    }

    it('should return valid for a correct active token', async () => {
      const plainToken = makePlainToken()
      const hashed = hashToken(plainToken)
      const tokenId = 'test-id-123'

      mockClient.hget.mockResolvedValue(tokenId)
      mockClient.hgetall.mockResolvedValue({
        id: tokenId,
        name: 'Test',
        isActive: 'true',
        expiresAt: '',
        hashedToken: hashed
      })

      const result = await agentTokenService.validateToken(plainToken)
      expect(result.valid).toBe(true)
      expect(result.tokenData.id).toBe(tokenId)
    })

    it('should reject token without ag_ prefix', async () => {
      const result = await agentTokenService.validateToken('cr_invalid')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Invalid token format')
    })

    it('should reject empty or null token', async () => {
      expect((await agentTokenService.validateToken('')).valid).toBe(false)
      expect((await agentTokenService.validateToken(null)).valid).toBe(false)
      expect((await agentTokenService.validateToken(undefined)).valid).toBe(false)
    })

    it('should reject token not found in hash map', async () => {
      mockClient.hget.mockResolvedValue(null)

      const result = await agentTokenService.validateToken(makePlainToken())
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Token not found')
    })

    it('should reject disabled token', async () => {
      mockClient.hget.mockResolvedValue('test-id')
      mockClient.hgetall.mockResolvedValue({
        id: 'test-id',
        name: 'Disabled',
        isActive: 'false',
        expiresAt: ''
      })

      const result = await agentTokenService.validateToken(makePlainToken())
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Token is disabled')
    })

    it('should reject expired token', async () => {
      mockClient.hget.mockResolvedValue('test-id')
      mockClient.hgetall.mockResolvedValue({
        id: 'test-id',
        name: 'Expired',
        isActive: 'true',
        expiresAt: '2020-01-01T00:00:00Z'
      })

      const result = await agentTokenService.validateToken(makePlainToken())
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Token has expired')
    })

    it('should accept token with future expiry', async () => {
      mockClient.hget.mockResolvedValue('test-id')
      mockClient.hgetall.mockResolvedValue({
        id: 'test-id',
        name: 'Valid Future',
        isActive: 'true',
        expiresAt: '2099-12-31T00:00:00Z'
      })

      const result = await agentTokenService.validateToken(makePlainToken())
      expect(result.valid).toBe(true)
    })

    it('should update lastUsedAt on successful validation', async () => {
      mockClient.hget.mockResolvedValue('test-id')
      mockClient.hgetall.mockResolvedValue({
        id: 'test-id',
        name: 'Test',
        isActive: 'true',
        expiresAt: ''
      })

      await agentTokenService.validateToken(makePlainToken())

      // Fire-and-forget hset for lastUsedAt
      expect(mockClient.hset).toHaveBeenCalledWith(
        'agent_token:test-id',
        'lastUsedAt',
        expect.any(String)
      )
    })
  })

  describe('getAllTokens', () => {
    it('should return empty array when no tokens exist', async () => {
      mockClient.scan.mockResolvedValue(['0', []])
      const result = await agentTokenService.getAllTokens()
      expect(result).toEqual([])
    })

    it('should return sanitized tokens (no hashedToken field)', async () => {
      mockClient.scan.mockResolvedValue(['0', ['agent_token:id1', 'agent_token:id2']])
      mockClient.hgetall
        .mockResolvedValueOnce({
          id: 'id1',
          name: 'Token 1',
          hashedToken: 'secret-hash-1',
          isActive: 'true',
          createdAt: '2025-01-01T00:00:00Z',
          expiresAt: '',
          createdBy: 'admin',
          lastUsedAt: '',
          description: ''
        })
        .mockResolvedValueOnce({
          id: 'id2',
          name: 'Token 2',
          hashedToken: 'secret-hash-2',
          isActive: 'false',
          createdAt: '2025-02-01T00:00:00Z',
          expiresAt: '2025-12-31T00:00:00Z',
          createdBy: 'admin',
          lastUsedAt: '2025-03-01T00:00:00Z',
          description: 'desc'
        })

      const result = await agentTokenService.getAllTokens()

      expect(result).toHaveLength(2)
      // Should not contain hashedToken
      expect(result[0]).not.toHaveProperty('hashedToken')
      expect(result[1]).not.toHaveProperty('hashedToken')
      // Should contain expected fields
      expect(result[0]).toHaveProperty('id')
      expect(result[0]).toHaveProperty('name')
      expect(result[0]).toHaveProperty('isActive')
    })

    it('should skip agent_token:hash_map key', async () => {
      mockClient.scan.mockResolvedValue(['0', ['agent_token:hash_map', 'agent_token:id1']])
      mockClient.hgetall.mockResolvedValue({
        id: 'id1',
        name: 'Token 1',
        isActive: 'true',
        createdAt: '2025-01-01T00:00:00Z',
        expiresAt: '',
        createdBy: 'admin',
        lastUsedAt: '',
        description: ''
      })

      const result = await agentTokenService.getAllTokens()
      // Should only call hgetall for id1, not hash_map
      expect(mockClient.hgetall).toHaveBeenCalledTimes(1)
      expect(result).toHaveLength(1)
    })

    it('should sort by createdAt descending', async () => {
      mockClient.scan.mockResolvedValue(['0', ['agent_token:old', 'agent_token:new']])
      mockClient.hgetall
        .mockResolvedValueOnce({
          id: 'old',
          name: 'Old Token',
          isActive: 'true',
          createdAt: '2024-01-01T00:00:00Z',
          expiresAt: '',
          createdBy: 'admin',
          lastUsedAt: '',
          description: ''
        })
        .mockResolvedValueOnce({
          id: 'new',
          name: 'New Token',
          isActive: 'true',
          createdAt: '2025-06-01T00:00:00Z',
          expiresAt: '',
          createdBy: 'admin',
          lastUsedAt: '',
          description: ''
        })

      const result = await agentTokenService.getAllTokens()
      expect(result[0].id).toBe('new')
      expect(result[1].id).toBe('old')
    })
  })

  describe('updateToken', () => {
    it('should update allowed fields', async () => {
      mockClient.hgetall.mockResolvedValue({
        id: 'test-id',
        name: 'Old Name',
        isActive: 'true',
        description: '',
        expiresAt: '',
        createdAt: '2025-01-01T00:00:00Z',
        createdBy: 'admin',
        lastUsedAt: ''
      })

      await agentTokenService.updateToken('test-id', {
        name: 'New Name',
        isActive: false,
        description: 'Updated desc'
      })

      expect(mockClient.hset).toHaveBeenCalledWith('agent_token:test-id', {
        name: 'New Name',
        isActive: 'false',
        description: 'Updated desc'
      })
    })

    it('should throw if token not found', async () => {
      mockClient.hgetall.mockResolvedValue(null)

      await expect(agentTokenService.updateToken('nonexistent', { name: 'New' })).rejects.toThrow(
        'Token not found'
      )
    })

    it('should throw if name is empty', async () => {
      mockClient.hgetall.mockResolvedValue({
        id: 'test-id',
        name: 'Old',
        isActive: 'true'
      })

      await expect(agentTokenService.updateToken('test-id', { name: '' })).rejects.toThrow(
        'Token name cannot be empty'
      )
    })

    it('should convert isActive to string', async () => {
      mockClient.hgetall.mockResolvedValue({
        id: 'test-id',
        name: 'Test',
        isActive: 'true',
        description: '',
        expiresAt: '',
        createdAt: '2025-01-01T00:00:00Z',
        createdBy: 'admin',
        lastUsedAt: ''
      })

      await agentTokenService.updateToken('test-id', { isActive: true })

      expect(mockClient.hset).toHaveBeenCalledWith('agent_token:test-id', {
        isActive: 'true'
      })
    })
  })

  describe('deleteToken', () => {
    it('should delete token and remove from hash map', async () => {
      mockClient.hgetall.mockResolvedValue({
        id: 'test-id',
        name: 'To Delete',
        hashedToken: 'hashed-value'
      })

      await agentTokenService.deleteToken('test-id')

      expect(mockClient.hdel).toHaveBeenCalledWith('agent_token:hash_map', 'hashed-value')
      expect(mockClient.del).toHaveBeenCalledWith('agent_token:test-id')
    })

    it('should throw if token not found', async () => {
      mockClient.hgetall.mockResolvedValue(null)

      await expect(agentTokenService.deleteToken('nonexistent')).rejects.toThrow('Token not found')
    })
  })

  describe('regenerateToken', () => {
    it('should generate new token and update hash map', async () => {
      mockClient.hgetall.mockResolvedValue({
        id: 'test-id',
        name: 'Regen Token',
        hashedToken: 'old-hash'
      })

      const result = await agentTokenService.regenerateToken('test-id')

      expect(result.token).toMatch(/^ag_[a-f0-9]{64}$/)
      expect(result.id).toBe('test-id')
      expect(result.name).toBe('Regen Token')

      // Should remove old hash
      expect(mockClient.hdel).toHaveBeenCalledWith('agent_token:hash_map', 'old-hash')
      // Should set new hash in token data
      expect(mockClient.hset).toHaveBeenCalledWith(
        'agent_token:test-id',
        expect.objectContaining({ hashedToken: expect.any(String) })
      )
      // Should add new hash to hash map
      expect(mockClient.hset).toHaveBeenCalledWith(
        'agent_token:hash_map',
        expect.any(String),
        'test-id'
      )
    })

    it('should throw if token not found', async () => {
      mockClient.hgetall.mockResolvedValue(null)

      await expect(agentTokenService.regenerateToken('nonexistent')).rejects.toThrow(
        'Token not found'
      )
    })
  })
})

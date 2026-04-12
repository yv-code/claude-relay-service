const express = require('express')
const request = require('supertest')

// Mock middleware
jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => {
    req.admin = { username: 'test-admin' }
    next()
  },
  authenticateAgentToken: (req, res, next) => {
    req.agentToken = { id: 'token-id', name: 'test-token' }
    next()
  }
}))

// Mock agentTokenService
const mockAgentTokenService = {
  getAllTokens: jest.fn(),
  generateToken: jest.fn(),
  updateToken: jest.fn(),
  getToken: jest.fn(),
  deleteToken: jest.fn(),
  regenerateToken: jest.fn()
}
jest.mock('../src/services/agentTokenService', () => mockAgentTokenService)

// Mock account services
const mockClaudeAccounts = [
  {
    id: 'acc1',
    name: 'Account 1',
    isActive: true,
    status: 'active',
    schedulable: true,
    rateLimitStatus: null
  },
  {
    id: 'acc2',
    name: 'Account 2',
    isActive: false,
    status: 'blocked',
    schedulable: true,
    rateLimitStatus: null
  },
  {
    id: 'acc3',
    name: 'Account 3',
    isActive: true,
    status: 'active',
    schedulable: false,
    rateLimitStatus: null
  }
]

jest.mock('../src/services/account/claudeAccountService', () => ({
  getAllAccounts: jest.fn().mockResolvedValue(mockClaudeAccounts)
}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAllAccounts: jest.fn().mockResolvedValue([])
}))
jest.mock('../src/services/account/bedrockAccountService', () => ({
  getAllAccounts: jest.fn().mockResolvedValue({ success: true, data: [] })
}))
jest.mock('../src/services/account/ccrAccountService', () => ({
  getAllAccounts: jest.fn().mockResolvedValue([])
}))
jest.mock('../src/services/account/geminiAccountService', () => ({
  getAllAccounts: jest.fn().mockResolvedValue([])
}))
jest.mock('../src/services/account/geminiApiAccountService', () => ({
  getAllAccounts: jest.fn().mockResolvedValue([])
}))
jest.mock('../src/services/account/openaiAccountService', () => ({
  getAllAccounts: jest.fn().mockResolvedValue([])
}))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAllAccounts: jest.fn().mockResolvedValue([])
}))
jest.mock('../src/services/account/azureOpenaiAccountService', () => ({
  getAllAccounts: jest.fn().mockResolvedValue([])
}))
jest.mock('../src/services/account/droidAccountService', () => ({
  getAllAccounts: jest.fn().mockResolvedValue([])
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

// Require routes AFTER mocks
const adminAgentTokensRouter = require('../src/routes/admin/agentTokens')
const agentRouter = require('../src/routes/agent')

describe('Admin Agent Token Routes', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/admin', adminAgentTokensRouter)
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('GET /admin/agent-tokens', () => {
    it('should return list of tokens', async () => {
      mockAgentTokenService.getAllTokens.mockResolvedValue([
        { id: 'id1', name: 'Token 1', isActive: true },
        { id: 'id2', name: 'Token 2', isActive: false }
      ])

      const app = buildApp()
      const res = await request(app).get('/admin/agent-tokens')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toHaveLength(2)
      expect(mockAgentTokenService.getAllTokens).toHaveBeenCalledTimes(1)
    })

    it('should return 500 on service error', async () => {
      mockAgentTokenService.getAllTokens.mockRejectedValue(new Error('Redis down'))

      const app = buildApp()
      const res = await request(app).get('/admin/agent-tokens')

      expect(res.status).toBe(500)
      expect(res.body.error).toBeDefined()
    })
  })

  describe('POST /admin/agent-tokens', () => {
    it('should create a token', async () => {
      mockAgentTokenService.generateToken.mockResolvedValue({
        id: 'new-id',
        token: 'ag_abc123',
        name: 'New Token'
      })

      const app = buildApp()
      const res = await request(app)
        .post('/admin/agent-tokens')
        .send({ name: 'New Token', description: 'Test' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.token).toBe('ag_abc123')
      expect(mockAgentTokenService.generateToken).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Token',
          description: 'Test',
          createdBy: 'test-admin'
        })
      )
    })

    it('should return 400 when name is missing', async () => {
      const app = buildApp()
      const res = await request(app).post('/admin/agent-tokens').send({})

      expect(res.status).toBe(400)
      expect(res.body.error).toBeDefined()
      expect(mockAgentTokenService.generateToken).not.toHaveBeenCalled()
    })

    it('should return 400 when name is empty string', async () => {
      const app = buildApp()
      const res = await request(app).post('/admin/agent-tokens').send({ name: '   ' })

      expect(res.status).toBe(400)
      expect(mockAgentTokenService.generateToken).not.toHaveBeenCalled()
    })
  })

  describe('PUT /admin/agent-tokens/:id', () => {
    it('should update a token', async () => {
      mockAgentTokenService.updateToken.mockResolvedValue({
        id: 'test-id',
        name: 'Updated',
        isActive: false
      })

      const app = buildApp()
      const res = await request(app)
        .put('/admin/agent-tokens/test-id')
        .send({ name: 'Updated', isActive: false })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(mockAgentTokenService.updateToken).toHaveBeenCalledWith('test-id', expect.any(Object))
    })

    it('should return 404 when token not found', async () => {
      mockAgentTokenService.updateToken.mockRejectedValue(new Error('Token not found'))

      const app = buildApp()
      const res = await request(app).put('/admin/agent-tokens/nonexistent').send({ name: 'Test' })

      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /admin/agent-tokens/:id', () => {
    it('should delete a token', async () => {
      mockAgentTokenService.deleteToken.mockResolvedValue(undefined)

      const app = buildApp()
      const res = await request(app).delete('/admin/agent-tokens/test-id')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(mockAgentTokenService.deleteToken).toHaveBeenCalledWith('test-id')
    })

    it('should return 404 when token not found', async () => {
      mockAgentTokenService.deleteToken.mockRejectedValue(new Error('Token not found'))

      const app = buildApp()
      const res = await request(app).delete('/admin/agent-tokens/nonexistent')

      expect(res.status).toBe(404)
    })
  })

  describe('POST /admin/agent-tokens/:id/regenerate', () => {
    it('should regenerate token', async () => {
      mockAgentTokenService.regenerateToken.mockResolvedValue({
        id: 'test-id',
        token: 'ag_newtoken123',
        name: 'Regen Token'
      })

      const app = buildApp()
      const res = await request(app).post('/admin/agent-tokens/test-id/regenerate')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.token).toBe('ag_newtoken123')
    })

    it('should return 404 when token not found', async () => {
      mockAgentTokenService.regenerateToken.mockRejectedValue(new Error('Token not found'))

      const app = buildApp()
      const res = await request(app).post('/admin/agent-tokens/nonexistent/regenerate')

      expect(res.status).toBe(404)
    })
  })
})

describe('Agent Routes', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/agent', agentRouter)
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('GET /agent/accounts/status', () => {
    it('should return account status for claude platform', async () => {
      const app = buildApp()
      const res = await request(app).get('/agent/accounts/status?platform=claude')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.platform).toBe('claude')
      expect(res.body.data.total).toBe(3)
      expect(res.body.data.normal).toBe(1) // acc1: active + schedulable
      expect(res.body.data.abnormal).toBe(1) // acc2: !isActive + blocked
      expect(res.body.data.paused).toBe(1) // acc3: active but !schedulable
    })

    it('should return 400 when platform is missing', async () => {
      const app = buildApp()
      const res = await request(app).get('/agent/accounts/status')

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.message).toBe('Please specify a platform')
      expect(res.body.availablePlatforms).toBeDefined()
    })

    it('should return 400 for invalid platform', async () => {
      const app = buildApp()
      const res = await request(app).get('/agent/accounts/status?platform=invalid')

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.message).toBe('Unknown platform: invalid')
      expect(res.body.availablePlatforms).toBeDefined()
    })

    it('should strip sensitive fields from account data', async () => {
      const app = buildApp()
      const res = await request(app).get('/agent/accounts/status?platform=claude')

      expect(res.status).toBe(200)
      const { accounts } = res.body.data
      for (const acc of accounts) {
        expect(acc).not.toHaveProperty('accessToken')
        expect(acc).not.toHaveProperty('refreshToken')
        expect(acc).not.toHaveProperty('sessionKey')
        expect(acc).not.toHaveProperty('cookie')
        expect(acc).not.toHaveProperty('password')
      }
    })

    it('should include _classification field for each account', async () => {
      const app = buildApp()
      const res = await request(app).get('/agent/accounts/status?platform=claude')

      const { accounts } = res.body.data
      expect(accounts[0]._classification).toBe('normal')
      expect(accounts[1]._classification).toBe('abnormal')
      expect(accounts[2]._classification).toBe('paused')
    })

    it('should return empty data for platform with no accounts', async () => {
      const app = buildApp()
      const res = await request(app).get('/agent/accounts/status?platform=ccr')

      expect(res.status).toBe(200)
      expect(res.body.data.total).toBe(0)
      expect(res.body.data.normal).toBe(0)
      expect(res.body.data.abnormal).toBe(0)
      expect(res.body.data.accounts).toEqual([])
    })
  })
})

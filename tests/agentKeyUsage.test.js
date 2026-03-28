const express = require('express')
const request = require('supertest')

// Mock config
jest.mock('../config/config', () => ({
  system: { timezoneOffset: 8 }
}))

// Mock middleware
jest.mock('../src/middleware/auth', () => ({
  authenticateAgentToken: (req, res, next) => {
    req.agentToken = { id: 'token-id', name: 'test-token' }
    next()
  }
}))

// Mock account services (required by agent/index.js imports)
jest.mock('../src/services/account/claudeAccountService', () => ({ getAllAccounts: jest.fn().mockResolvedValue([]) }))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({ getAllAccounts: jest.fn().mockResolvedValue([]) }))
jest.mock('../src/services/account/bedrockAccountService', () => ({ getAllAccounts: jest.fn().mockResolvedValue({ success: true, data: [] }) }))
jest.mock('../src/services/account/ccrAccountService', () => ({ getAllAccounts: jest.fn().mockResolvedValue([]) }))
jest.mock('../src/services/account/geminiAccountService', () => ({ getAllAccounts: jest.fn().mockResolvedValue([]) }))
jest.mock('../src/services/account/geminiApiAccountService', () => ({ getAllAccounts: jest.fn().mockResolvedValue([]) }))
jest.mock('../src/services/account/openaiAccountService', () => ({ getAllAccounts: jest.fn().mockResolvedValue([]) }))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({ getAllAccounts: jest.fn().mockResolvedValue([]) }))
jest.mock('../src/services/account/azureOpenaiAccountService', () => ({ getAllAccounts: jest.fn().mockResolvedValue([]) }))
jest.mock('../src/services/account/droidAccountService', () => ({ getAllAccounts: jest.fn().mockResolvedValue([]) }))

// Mock logger
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

// Mock upstreamErrorHelper
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  getAllTempUnavailable: jest.fn().mockResolvedValue({})
}))

// Pipeline mock helper
const createMockPipeline = (results) => {
  const cmds = []
  const pl = {
    hget: jest.fn((...args) => { cmds.push({ cmd: 'hget', args }); return pl }),
    hgetall: jest.fn((...args) => { cmds.push({ cmd: 'hgetall', args }); return pl }),
    get: jest.fn((...args) => { cmds.push({ cmd: 'get', args }); return pl }),
    exec: jest.fn().mockResolvedValue(results),
    _cmds: cmds
  }
  return pl
}

// Mock redis
const mockRedis = {
  getClientSafe: jest.fn()
}
jest.mock('../src/models/redis', () => mockRedis)

const agentRouter = require('../src/routes/agent')

const buildApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/agent', agentRouter)
  return app
}

describe('POST /agent/keys/usage', () => {
  let app

  beforeEach(() => {
    jest.clearAllMocks()
    app = buildApp()
  })

  // --- 参数校验 ---

  it('should return 400 when keys is missing', async () => {
    const res = await request(app)
      .post('/agent/keys/usage')
      .send({ startTime: '2026-03-28 00:00', endTime: '2026-03-28 23:59' })

    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(res.body.message).toMatch(/keys/)
  })

  it('should return 400 when keys is empty array', async () => {
    const res = await request(app)
      .post('/agent/keys/usage')
      .send({ keys: [] })

    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
  })

  it('should return 400 for invalid timezone format', async () => {
    const res = await request(app)
      .post('/agent/keys/usage')
      .send({ keys: ['k1'], timezone: 'UTC+8' })

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/timezone/)
  })

  it('should return 400 for invalid startTime format', async () => {
    mockRedis.getClientSafe.mockReturnValue({
      pipeline: () => createMockPipeline([])
    })

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({ keys: ['k1'], startTime: '2026/03/28 00:00' })

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/startTime/)
  })

  it('should return 400 for invalid endTime format', async () => {
    mockRedis.getClientSafe.mockReturnValue({
      pipeline: () => createMockPipeline([])
    })

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({ keys: ['k1'], endTime: 'bad' })

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/endTime/)
  })

  it('should return 400 when startTime >= endTime', async () => {
    mockRedis.getClientSafe.mockReturnValue({
      pipeline: () => createMockPipeline([])
    })

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['k1'],
        startTime: '2026-03-28 12:00',
        endTime: '2026-03-28 10:00'
      })

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/before/)
  })

  // --- Key 解析 ---

  it('should resolve key by keyId', async () => {
    const idPipeline = createMockPipeline([
      [null, 'My Key'] // hget apikey:key1 name → found
    ])
    const usagePipeline = createMockPipeline([])

    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(usagePipeline)
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['key1'],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.keys).toHaveProperty('key1')
    expect(res.body.data.keys.key1.name).toBe('My Key')
    expect(res.body.data.notFound).toEqual([])
  })

  it('should resolve key by name via index', async () => {
    const idPipeline = createMockPipeline([
      [null, null] // hget apikey:my-key name → not found by id
    ])

    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(createMockPipeline([])), // usage pipeline
      zrangebylex: jest.fn().mockResolvedValue(['my-key\x00resolved-id']),
      hget: jest.fn().mockResolvedValue('My Key Name')
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['my-key'],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    expect(mockClient.zrangebylex).toHaveBeenCalledWith(
      'apikey:idx:name',
      expect.stringContaining('my-key'),
      expect.any(String)
    )
    expect(res.body.data.keys).toHaveProperty('resolved-id')
    expect(res.body.data.keys['resolved-id'].name).toBe('My Key Name')
  })

  it('should report unresolved keys in notFound', async () => {
    const idPipeline = createMockPipeline([
      [null, null]
    ])

    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(createMockPipeline([])),
      zrangebylex: jest.fn().mockResolvedValue([]) // name lookup also fails
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['ghost-key'],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    expect(res.body.data.notFound).toContain('ghost-key')
    expect(Object.keys(res.body.data.keys)).toHaveLength(0)
  })

  // --- 用量查询与汇总 ---

  it('should aggregate same-day hourly usage for a single key', async () => {
    // key1 resolved by id
    const idPipeline = createMockPipeline([
      [null, 'TestKey']
    ])

    // Same-day: startHour=10, endHour=12 → 3 hourly buckets
    // Each hourly bucket = 2 pipeline cmds: hgetall + get(cost)
    // 3 hours × 2 = 6 results
    const usageResults = [
      // hour 10
      [null, { requests: '10', inputTokens: '100', outputTokens: '200', cacheCreateTokens: '0', cacheReadTokens: '0', allTokens: '300' }],
      [null, '1.50'],
      // hour 11
      [null, { requests: '20', inputTokens: '200', outputTokens: '400', cacheCreateTokens: '50', cacheReadTokens: '100', allTokens: '750' }],
      [null, '3.00'],
      // hour 12
      [null, { requests: '5', inputTokens: '50', outputTokens: '100', cacheCreateTokens: '0', cacheReadTokens: '0', allTokens: '150' }],
      [null, '0.75']
    ]
    const usagePipeline = createMockPipeline(usageResults)

    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(usagePipeline)
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['key1'],
        startTime: '2026-03-28 10:00',
        endTime: '2026-03-28 12:59'
      })

    expect(res.status).toBe(200)
    const keyData = res.body.data.keys.key1
    expect(keyData.requests).toBe(35)
    expect(keyData.inputTokens).toBe(350)
    expect(keyData.outputTokens).toBe(700)
    expect(keyData.cacheCreateTokens).toBe(50)
    expect(keyData.cacheReadTokens).toBe(100)
    expect(keyData.allTokens).toBe(1200)
    expect(keyData.cost).toBe(5.25)
    expect(keyData.dailyFallback).toBe(false)

    // total should match for single key
    expect(res.body.data.total.requests).toBe(35)
    expect(res.body.data.total.cost).toBe(5.25)
  })

  it('should use daily query for full days in multi-day range', async () => {
    const idPipeline = createMockPipeline([
      [null, 'K1']
    ])

    // 3/26 00:00 ~ 3/28 23:59 → all full days → 3 daily queries
    // Each daily = 3 cmds: hgetall + get(cost) + get(realCost)
    const usageResults = [
      // day 1
      [null, { requests: '100', inputTokens: '1000', outputTokens: '2000', cacheCreateTokens: '0', cacheReadTokens: '0', allTokens: '3000' }],
      [null, '10.00'], [null, '5.00'],
      // day 2
      [null, { requests: '200', inputTokens: '2000', outputTokens: '4000', cacheCreateTokens: '0', cacheReadTokens: '0', allTokens: '6000' }],
      [null, '20.00'], [null, '10.00'],
      // day 3
      [null, { requests: '50', inputTokens: '500', outputTokens: '1000', cacheCreateTokens: '0', cacheReadTokens: '0', allTokens: '1500' }],
      [null, '5.00'], [null, '2.50']
    ]

    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(createMockPipeline(usageResults))
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['key1'],
        startTime: '2026-03-26 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    const keyData = res.body.data.keys.key1
    expect(keyData.requests).toBe(350)
    expect(keyData.cost).toBe(35)
    expect(keyData.realCost).toBe(17.5)
  })

  it('should aggregate across multiple keys and produce correct total', async () => {
    const idPipeline = createMockPipeline([
      [null, 'Key A'],
      [null, 'Key B']
    ])

    // Full-day query → 1 daily × 3 cmds per key = 3 per key, 6 total
    const usageResults = [
      // key-a day
      [null, { requests: '10', inputTokens: '100', outputTokens: '200', cacheCreateTokens: '0', cacheReadTokens: '0', allTokens: '300' }],
      [null, '2.00'], [null, '1.00'],
      // key-b day
      [null, { requests: '30', inputTokens: '300', outputTokens: '600', cacheCreateTokens: '0', cacheReadTokens: '0', allTokens: '900' }],
      [null, '6.00'], [null, '3.00']
    ]

    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(createMockPipeline(usageResults))
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['key-a', 'key-b'],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    expect(res.body.data.total.requests).toBe(40)
    expect(res.body.data.total.cost).toBe(8)
    expect(res.body.data.total.realCost).toBe(4)
  })

  // --- 时区处理 ---

  it('should default timezone to +08:00', async () => {
    const idPipeline = createMockPipeline([[null, 'K']])
    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(createMockPipeline([]))
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['k'],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    expect(res.body.data.timezone).toBe('+08:00')
  })

  it('should accept negative timezone offset', async () => {
    const idPipeline = createMockPipeline([[null, 'K']])
    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(createMockPipeline([]))
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['k'],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59',
        timezone: '-05:00'
      })

    expect(res.status).toBe(200)
    expect(res.body.data.timezone).toBe('-05:00')
  })

  // --- dailyFallback ---

  it('should mark dailyFallback when hourly data is expired', async () => {
    const idPipeline = createMockPipeline([[null, 'OldKey']])

    // Query a date >7 days ago with partial hours → should fallback to daily
    // daily-fallback = 3 cmds
    const usageResults = [
      [null, { requests: '50', inputTokens: '500', outputTokens: '1000', cacheCreateTokens: '0', cacheReadTokens: '0', allTokens: '1500' }],
      [null, '5.00'], [null, '2.50']
    ]

    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(createMockPipeline(usageResults))
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['key1'],
        startTime: '2026-03-10 10:00',
        endTime: '2026-03-10 15:00'
      })

    expect(res.status).toBe(200)
    expect(res.body.data.keys.key1.dailyFallback).toBe(true)
  })

  // --- 响应结构 ---

  it('should return correct response structure', async () => {
    const idPipeline = createMockPipeline([[null, 'K']])
    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(createMockPipeline([]))
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['k'],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    const { data } = res.body
    expect(data).toHaveProperty('startTime')
    expect(data).toHaveProperty('endTime')
    expect(data).toHaveProperty('timezone')
    expect(data).toHaveProperty('keys')
    expect(data).toHaveProperty('total')
    expect(data).toHaveProperty('notFound')

    expect(data.total).toHaveProperty('requests')
    expect(data.total).toHaveProperty('inputTokens')
    expect(data.total).toHaveProperty('outputTokens')
    expect(data.total).toHaveProperty('cacheCreateTokens')
    expect(data.total).toHaveProperty('cacheReadTokens')
    expect(data.total).toHaveProperty('allTokens')
    expect(data.total).toHaveProperty('cost')
    expect(data.total).toHaveProperty('realCost')
  })

  // --- 默认时间 ---

  it('should use default start/end time when not provided', async () => {
    const idPipeline = createMockPipeline([[null, 'K']])
    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(createMockPipeline([]))
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({ keys: ['k'] })

    expect(res.status).toBe(200)
    // Should have startTime/endTime filled with today's date
    expect(res.body.data.startTime).toMatch(/^\d{4}-\d{2}-\d{2} 00:00$/)
    expect(res.body.data.endTime).toMatch(/^\d{4}-\d{2}-\d{2} 23:59$/)
  })

  // --- 空用量 ---

  it('should return zeroes when no usage data exists', async () => {
    const idPipeline = createMockPipeline([[null, 'EmptyKey']])
    // daily query returns empty hash and null costs
    const usageResults = [
      [null, {}], [null, null], [null, null]
    ]
    const mockClient = {
      pipeline: jest.fn()
        .mockReturnValueOnce(idPipeline)
        .mockReturnValueOnce(createMockPipeline(usageResults))
    }
    mockRedis.getClientSafe.mockReturnValue(mockClient)

    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['k'],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    const keyData = res.body.data.keys.k
    expect(keyData.requests).toBe(0)
    expect(keyData.inputTokens).toBe(0)
    expect(keyData.outputTokens).toBe(0)
    expect(keyData.cost).toBe(0)
    expect(keyData.realCost).toBe(0)
  })
})

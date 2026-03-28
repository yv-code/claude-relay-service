/**
 * POST /agent/keys/usage 集成测试
 *
 * 需要真实 Redis 连接。通过 fixture 使用项目自身的 redis model 创建数据，
 * 确保数据结构与生产环境完全一致。
 *
 * 运行: REDIS_TEST=1 npm test -- agentKeyUsage.integration
 * 不设 REDIS_TEST 时所有用例显示 skipped
 */

const express = require('express')
const request = require('supertest')

// 只 mock 与 Redis 无关的模块
jest.mock('../src/middleware/auth', () => ({
  authenticateAgentToken: (req, res, next) => {
    req.agentToken = { id: 'test-token', name: 'integration-test' }
    next()
  }
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  getAllAccounts: jest.fn().mockResolvedValue([])
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
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  getAllTempUnavailable: jest.fn().mockResolvedValue({})
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

const fixture = require('./fixtures/keyUsageTestData')
const { TEST_KEYS } = fixture

const skipRealRedis = !process.env.REDIS_TEST

let app
let redisConnected = false

beforeAll(async () => {
  if (skipRealRedis) {
    console.log('⏭️  Skipping Redis integration tests (set REDIS_TEST=1 to enable)')
    return
  }

  try {
    await fixture.connectRedis()
    redisConnected = true
    await fixture.setup()

    const agentRouter = require('../src/routes/agent')
    app = express()
    app.use(express.json())
    app.use('/agent', agentRouter)
  } catch (err) {
    console.warn('⚠️  Redis connection failed, tests will be skipped:', err.message)
  }
})

afterAll(async () => {
  if (redisConnected) {
    await fixture.teardown()
    await fixture.disconnect()
  }
})

describe('POST /agent/keys/usage (integration)', () => {
  const testOrSkip = skipRealRedis ? it.skip : it

  testOrSkip('should query full-day usage by keyId', async () => {
    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: [TEST_KEYS.key1.id],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)

    const keyData = res.body.data.keys[TEST_KEYS.key1.id]
    expect(keyData).toBeDefined()
    expect(keyData.name).toBe('IntegrationTestKey1')
    // daily 是 hourly 累加: 30+40=70 requests
    expect(keyData.requests).toBe(70)
    expect(keyData.inputTokens).toBe(35000)
    expect(keyData.outputTokens).toBe(85000)
    expect(keyData.cacheCreateTokens).toBe(13000)
    expect(keyData.cacheReadTokens).toBe(500000)
    expect(keyData.allTokens).toBe(633000)
    // cost: 3.0+4.5=7.5
    expect(keyData.cost).toBe(7.5)
    // realCost: 1.5+2.25=3.75
    expect(keyData.realCost).toBe(3.75)
    expect(keyData.dailyFallback).toBe(false)
  })

  testOrSkip('should query partial-day hourly range', async () => {
    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: [TEST_KEYS.key1.id],
        startTime: '2026-03-28 10:00',
        endTime: '2026-03-28 10:59'
      })

    expect(res.status).toBe(200)
    const keyData = res.body.data.keys[TEST_KEYS.key1.id]
    // 只有 hour 10 的数据
    expect(keyData.requests).toBe(30)
    expect(keyData.cost).toBe(3)
  })

  testOrSkip('should aggregate across multiple keys', async () => {
    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: [TEST_KEYS.key1.id, TEST_KEYS.key2.id],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    const { total } = res.body.data
    // key1: 70 + key2: 50 = 120
    expect(total.requests).toBe(120)
    // key1: 7.5 + key2: 5.0 = 12.5
    expect(total.cost).toBe(12.5)
  })

  testOrSkip('should resolve key by name via index', async () => {
    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: ['integrationtestkey1'],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    // 应解析为 key1 的 id
    expect(res.body.data.keys[TEST_KEYS.key1.id]).toBeDefined()
    expect(res.body.data.notFound).toEqual([])
  })

  testOrSkip('should report unresolved keys in notFound', async () => {
    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: [TEST_KEYS.key1.id, 'nonexistent-key'],
        startTime: '2026-03-28 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    expect(res.body.data.notFound).toContain('nonexistent-key')
    expect(res.body.data.keys[TEST_KEYS.key1.id]).toBeDefined()
  })

  testOrSkip('should query multi-day range with daily + hourly', async () => {
    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: [TEST_KEYS.key1.id],
        startTime: '2026-03-27 00:00',
        endTime: '2026-03-28 23:59'
      })

    expect(res.status).toBe(200)
    const keyData = res.body.data.keys[TEST_KEYS.key1.id]
    // 3/27 daily: 200 + 3/28 daily: 70 = 270
    expect(keyData.requests).toBe(270)
    // 3/27 cost: 20 + 3/28 cost: 7.5 = 27.5
    expect(keyData.cost).toBe(27.5)
    // 3/27 realCost: 10 + 3/28 realCost: 3.75 = 13.75
    expect(keyData.realCost).toBe(13.75)
  })

  testOrSkip('should return zeroes for a key with no usage in range', async () => {
    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: [TEST_KEYS.key2.id],
        startTime: '2026-03-27 00:00',
        endTime: '2026-03-27 23:59'
      })

    expect(res.status).toBe(200)
    const keyData = res.body.data.keys[TEST_KEYS.key2.id]
    expect(keyData.requests).toBe(0)
    expect(keyData.cost).toBe(0)
  })

  testOrSkip('should include correct response metadata', async () => {
    const res = await request(app)
      .post('/agent/keys/usage')
      .send({
        keys: [TEST_KEYS.key1.id],
        startTime: '2026-03-28 10:00',
        endTime: '2026-03-28 11:59',
        timezone: '+08:00'
      })

    expect(res.status).toBe(200)
    const { data } = res.body
    expect(data.startTime).toBe('2026-03-28 10:00')
    expect(data.endTime).toBe('2026-03-28 11:59')
    expect(data.timezone).toBe('+08:00')
    expect(Array.isArray(data.notFound)).toBe(true)
  })
})

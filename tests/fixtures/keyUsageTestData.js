/**
 * Key Usage 集成测试数据 fixture
 *
 * 使用项目自身的 redis model 和 apiKeyIndexService 创建/清理测试数据，
 * 确保数据结构与真实运行时完全一致。
 */

const crypto = require('crypto')
const redis = require('../../src/models/redis')
const apiKeyIndexService = require('../../src/services/apiKeyIndexService')

// 测试 key 前缀，便于清理
const TEST_PREFIX = '_test_ku_'

// 固定的测试 Key 定义
const TEST_KEYS = {
  key1: {
    id: `${TEST_PREFIX}key-1`,
    name: 'IntegrationTestKey1',
    description: 'key-usage integration test key 1'
  },
  key2: {
    id: `${TEST_PREFIX}key-2`,
    name: 'IntegrationTestKey2',
    description: 'key-usage integration test key 2'
  }
}

/**
 * 连接 Redis 并初始化索引服务
 */
async function connectRedis() {
  if (!redis.isConnected) {
    await redis.connect()
  }
  apiKeyIndexService.init(redis)
}

/**
 * 创建一个测试 API Key（通过 redis.setApiKey + apiKeyIndexService.addToIndex）
 */
async function createTestApiKey(def) {
  const hashedKey = crypto.createHash('sha256').update(`test-raw-${def.id}`).digest('hex')

  const keyData = {
    id: def.id,
    name: def.name,
    description: def.description,
    apiKey: hashedKey,
    createdAt: new Date().toISOString(),
    lastUsedAt: '',
    isActive: 'true',
    isDeleted: 'false',
    permissions: '[]',
    tags: '[]',
    concurrencyLimit: '0',
    tokenLimit: '0',
    dailyCostLimit: '0',
    totalCostLimit: '0',
    enableModelRestriction: 'false',
    restrictedModels: '[]',
    enableClientRestriction: 'false',
    allowedClients: '[]',
    createdBy: 'integration-test'
  }

  await redis.setApiKey(def.id, keyData, hashedKey)
  await apiKeyIndexService.addToIndex(keyData)
}

/**
 * 通过 redis.incrementUsageData 写入用量
 * 需要把时间切到指定的 date/hour 来构造正确的 Redis key
 *
 * 由于 incrementUsageData 内部用 Date.now() 构造 key，
 * 我们直接用底层 pipeline 按照 recordUsage 的格式写入，
 * 保证字段结构与 incrementUsageData 完全一致。
 */
async function writeUsage(keyId, dateStr, hour, data) {
  const client = redis.getClientSafe()
  const pipeline = client.pipeline()

  const hourStr = `${dateStr}:${String(hour).padStart(2, '0')}`

  const fields = {
    tokens: (data.inputTokens || 0) + (data.outputTokens || 0),
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    cacheCreateTokens: data.cacheCreateTokens || 0,
    cacheReadTokens: data.cacheReadTokens || 0,
    allTokens: data.allTokens || 0,
    requests: data.requests || 0
  }

  // hourly（与 incrementUsageData 写入相同字段）
  const hourlyKey = `usage:hourly:${keyId}:${hourStr}`
  for (const [field, value] of Object.entries(fields)) {
    pipeline.hincrby(hourlyKey, field, value)
  }
  pipeline.expire(hourlyKey, 86400 * 7)

  // daily（同结构）
  const dailyKey = `usage:daily:${keyId}:${dateStr}`
  for (const [field, value] of Object.entries(fields)) {
    pipeline.hincrby(dailyKey, field, value)
  }
  pipeline.expire(dailyKey, 86400 * 32)

  // 索引
  pipeline.sadd(`usage:daily:index:${dateStr}`, keyId)
  pipeline.sadd(`usage:hourly:index:${hourStr}`, keyId)

  await pipeline.exec()
}

/**
 * 通过底层 INCRBYFLOAT 写入费用（与 incrementDailyCost 相同结构）
 */
async function writeCost(keyId, dateStr, hour, cost, realCost) {
  const client = redis.getClientSafe()
  const pipeline = client.pipeline()

  const hourStr = `${dateStr}:${String(hour).padStart(2, '0')}`

  // hourly cost（rated）
  pipeline.incrbyfloat(`usage:cost:hourly:${keyId}:${hourStr}`, cost)
  pipeline.expire(`usage:cost:hourly:${keyId}:${hourStr}`, 86400 * 7)

  // daily cost（rated + real）
  pipeline.incrbyfloat(`usage:cost:daily:${keyId}:${dateStr}`, cost)
  pipeline.expire(`usage:cost:daily:${keyId}:${dateStr}`, 86400 * 30)
  pipeline.incrbyfloat(`usage:cost:real:daily:${keyId}:${dateStr}`, realCost)
  pipeline.expire(`usage:cost:real:daily:${keyId}:${dateStr}`, 86400 * 30)

  await pipeline.exec()
}

/**
 * 搭建完整的测试数据集
 *
 * key1: 3/28 10:00-11:00 有 hourly 数据，3/27 有 daily 数据
 * key2: 3/28 有 daily 数据
 */
async function setup() {
  await connectRedis()

  // 创建两个测试 API Key
  await createTestApiKey(TEST_KEYS.key1)
  await createTestApiKey(TEST_KEYS.key2)

  // --- key1 用量 ---
  // 3/28 hour 10
  await writeUsage(TEST_KEYS.key1.id, '2026-03-28', 10, {
    requests: 30,
    inputTokens: 15000,
    outputTokens: 35000,
    cacheCreateTokens: 5000,
    cacheReadTokens: 200000,
    allTokens: 255000
  })
  await writeCost(TEST_KEYS.key1.id, '2026-03-28', 10, 3.0, 1.5)

  // 3/28 hour 11
  await writeUsage(TEST_KEYS.key1.id, '2026-03-28', 11, {
    requests: 40,
    inputTokens: 20000,
    outputTokens: 50000,
    cacheCreateTokens: 8000,
    cacheReadTokens: 300000,
    allTokens: 378000
  })
  await writeCost(TEST_KEYS.key1.id, '2026-03-28', 11, 4.5, 2.25)

  // 3/27 全天（只写 daily，不写 hourly 便于测试全天查询）
  await writeUsage(TEST_KEYS.key1.id, '2026-03-27', 0, {
    requests: 200,
    inputTokens: 80000,
    outputTokens: 200000,
    cacheCreateTokens: 20000,
    cacheReadTokens: 1000000,
    allTokens: 1300000
  })
  await writeCost(TEST_KEYS.key1.id, '2026-03-27', 0, 20.0, 10.0)

  // 为 key1 和 key2 添加 tag（模拟管理员打标签）
  const client = redis.getClientSafe()
  const tagPipeline = client.pipeline()
  tagPipeline.sadd('apikey:tag:test-user', TEST_KEYS.key1.id)
  tagPipeline.sadd('apikey:tag:test-user', TEST_KEYS.key2.id)
  tagPipeline.sadd('apikey:tag:solo-user', TEST_KEYS.key1.id)
  await tagPipeline.exec()

  // --- key2 用量 ---
  // 3/28 hour 10（整日写一条 hourly 也会累加到 daily）
  await writeUsage(TEST_KEYS.key2.id, '2026-03-28', 10, {
    requests: 50,
    inputTokens: 25000,
    outputTokens: 60000,
    cacheCreateTokens: 10000,
    cacheReadTokens: 400000,
    allTokens: 495000
  })
  await writeCost(TEST_KEYS.key2.id, '2026-03-28', 10, 5.0, 2.5)
}

/**
 * 清理所有测试数据
 */
async function teardown() {
  const client = redis.getClientSafe()

  const keyIds = Object.values(TEST_KEYS).map((k) => k.id)
  const dates = ['2026-03-27', '2026-03-28']
  const hours = ['00', '10', '11']

  const pipeline = client.pipeline()

  for (const keyId of keyIds) {
    // apikey hash + hash_map
    const hashedKey = crypto.createHash('sha256').update(`test-raw-${keyId}`).digest('hex')
    pipeline.del(`apikey:${keyId}`)
    pipeline.hdel('apikey:hash_map', hashedKey)

    for (const date of dates) {
      // usage daily
      pipeline.del(`usage:daily:${keyId}:${date}`)
      pipeline.del(`usage:cost:daily:${keyId}:${date}`)
      pipeline.del(`usage:cost:real:daily:${keyId}:${date}`)
      pipeline.srem(`usage:daily:index:${date}`, keyId)

      for (const hh of hours) {
        const hourStr = `${date}:${hh}`
        pipeline.del(`usage:hourly:${keyId}:${hourStr}`)
        pipeline.del(`usage:cost:hourly:${keyId}:${hourStr}`)
        pipeline.srem(`usage:hourly:index:${hourStr}`, keyId)
      }
    }
  }

  // 清理 tag 索引
  pipeline.del('apikey:tag:test-user')
  pipeline.del('apikey:tag:solo-user')

  await pipeline.exec()

  // 清理索引
  for (const def of Object.values(TEST_KEYS)) {
    await apiKeyIndexService.removeFromIndex(def.id, { name: def.name, tags: [] })
  }
}

/**
 * 断开 Redis
 */
async function disconnect() {
  await redis.disconnect()
}

module.exports = {
  TEST_PREFIX,
  TEST_KEYS,
  setup,
  teardown,
  disconnect,
  connectRedis
}

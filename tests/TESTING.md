# 测试规范

## 文件命名

| 类型 | 命名 | 示例 |
|------|------|------|
| 单元测试 | `*.test.js` | `pricingService.test.js` |
| 集成测试 | `*.integration.test.js` | `agentKeyUsage.integration.test.js` |
| 测试 fixture | `fixtures/*.js` | `fixtures/keyUsageTestData.js` |

## 单元测试

Mock 所有外部依赖（Redis、services、logger），只测试被测模块自身逻辑。

```js
// mock 放在文件顶部，require 放在 mock 之后
jest.mock('../src/models/redis', () => ({ ... }))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(),
  error: jest.fn(), success: jest.fn(), api: jest.fn(), security: jest.fn()
}))

// mock 之后再 require 被测模块
const myModule = require('../src/services/myModule')
```

- `beforeEach` 中 `jest.clearAllMocks()`
- pipeline mock 模式：返回链式对象 + `exec()` 返回预设结果数组

## 集成测试

连接真实 Redis，通过 fixture 用项目自身的 service 层创建数据。

### 环境变量控制与可见性

通过 `REDIS_TEST=1` 环境变量控制是否执行，使用 `it.skip` 让测试报告明确显示 **skipped**（而非静默 pass）：

```js
const skipRealRedis = !process.env.REDIS_TEST

beforeAll(async () => {
  if (skipRealRedis) {
    console.log('⏭️  Skipping Redis integration tests (set REDIS_TEST=1 to enable)')
    return
  }
  try {
    await fixture.connectRedis()
    // ...
  } catch (err) {
    console.warn('⚠️  Redis connection failed, tests will be skipped:', err.message)
  }
})

describe('my tests', () => {
  const testOrSkip = skipRealRedis ? it.skip : it

  testOrSkip('should do something', async () => {
    // 真正的测试逻辑
  })
})
```

这样：
- `npm test` → 显示 `8 skipped`，外部 CI 可明确感知未执行
- `REDIS_TEST=1 npm test` → 真正连接 Redis 执行测试

### mock 策略

只 mock 与被测功能无关的模块（auth 中间件、logger 等），**不 mock Redis**。

### 生命周期

```
beforeAll  → 连接 Redis → setup 数据 → 构建 app
afterAll   → teardown 清理 → 断开 Redis
```

## Fixture 编写规范

Fixture 放在 `tests/fixtures/` 下，导出 `setup()` / `teardown()` / `connectRedis()` / `disconnect()`。

### 核心原则

**用项目 service 层创建数据，不手写 Redis 命令。** 确保数据结构与生产环境完全一致。

| 操作 | 正确做法 | 错误做法 |
|------|----------|----------|
| 创建 API Key | `redis.setApiKey()` + `apiKeyIndexService.addToIndex()` | `redis-cli hset apikey:xx ...` |
| 写入用量 | `pipeline.hincrby` 按 `incrementUsageData` 的字段写入 | 只写部分字段 |
| 写入费用 | `pipeline.incrbyfloat` 按 `incrementDailyCost` 的结构写入 | `redis-cli set` |
| 清理 | `teardown()` 中 pipeline 批量 `del` + `srem` | 不清理 / 手动清理 |

### 测试数据隔离

- 测试 key ID 使用固定前缀（如 `_test_ku_`），避免与真实数据冲突
- teardown 必须清理所有创建的 key（包括索引条目）
- 不依赖已有数据，fixture 自包含

### 数据结构参考

创建 API Key 时需要的核心字段：

```js
{
  id, name, description, apiKey /* SHA-256 hash */,
  createdAt, lastUsedAt, isActive, isDeleted,
  permissions, tags, concurrencyLimit, tokenLimit,
  dailyCostLimit, totalCostLimit,
  enableModelRestriction, restrictedModels,
  enableClientRestriction, allowedClients,
  createdBy
}
```

用量 hash 字段（`usage:daily:` / `usage:hourly:`）：

```
requests, inputTokens, outputTokens,
cacheCreateTokens, cacheReadTokens, allTokens
```

费用 key（string，INCRBYFLOAT）：

```
usage:cost:hourly:{keyId}:{date:HH}     — 7 天过期
usage:cost:daily:{keyId}:{date}          — 30 天过期
usage:cost:real:daily:{keyId}:{date}     — 30 天过期
```

## 运行命令

```bash
npm test                                                # 全部测试（集成测试显示 skipped）
npm test -- agentKeyUsage                               # 按文件名匹配
REDIS_TEST=1 npm test -- agentKeyUsage.integration      # 连接真实 Redis 跑集成测试
npm test -- --coverage                                  # 覆盖率报告
```

const express = require('express')
const { authenticateAgentToken } = require('../../middleware/auth')
const claudeAccountService = require('../../services/account/claudeAccountService')
const claudeConsoleAccountService = require('../../services/account/claudeConsoleAccountService')
const bedrockAccountService = require('../../services/account/bedrockAccountService')
const ccrAccountService = require('../../services/account/ccrAccountService')
const geminiAccountService = require('../../services/account/geminiAccountService')
const geminiApiAccountService = require('../../services/account/geminiApiAccountService')
const openaiAccountService = require('../../services/account/openaiAccountService')
const openaiResponsesAccountService = require('../../services/account/openaiResponsesAccountService')
const azureOpenaiAccountService = require('../../services/account/azureOpenaiAccountService')
const droidAccountService = require('../../services/account/droidAccountService')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')

const router = express.Router()

// 平台到获取函数的映射
const PLATFORM_FETCHERS = {
  claude: {
    fetch: () => claudeAccountService.getAllAccounts(),
    getOne: (id) => claudeAccountService.getAccount(id),
    opts: {}
  },
  'claude-console': {
    fetch: () => claudeConsoleAccountService.getAllAccounts(),
    getOne: (id) => claudeConsoleAccountService.getAccount(id),
    opts: {}
  },
  gemini: {
    fetch: () => geminiAccountService.getAllAccounts(),
    getOne: (id) => geminiAccountService.getAccount(id),
    opts: { checkGeminiRateLimit: true }
  },
  'gemini-api': {
    fetch: () => geminiApiAccountService.getAllAccounts(true),
    getOne: (id) => geminiApiAccountService.getAccount(id),
    opts: { isStringType: true }
  },
  openai: {
    fetch: () => openaiAccountService.getAllAccounts(),
    getOne: (id) => openaiAccountService.getAccount(id),
    opts: { isStringType: true }
  },
  'openai-responses': {
    fetch: () => openaiResponsesAccountService.getAllAccounts(true),
    getOne: (id) => openaiResponsesAccountService.getAccount(id),
    opts: { isStringType: true }
  },
  'azure-openai': {
    fetch: () => azureOpenaiAccountService.getAllAccounts(),
    getOne: (id) => azureOpenaiAccountService.getAccount(id),
    opts: { isStringType: true }
  },
  bedrock: {
    fetch: async () => {
      const result = await bedrockAccountService.getAllAccounts()
      return result.success ? result.data : []
    },
    getOne: async (id) => {
      const result = await bedrockAccountService.getAccount(id)
      return result.success ? result.data : null
    },
    opts: {}
  },
  droid: {
    fetch: () => droidAccountService.getAllAccounts(),
    getOne: (id) => droidAccountService.getAccount(id),
    opts: { isDroid: true }
  },
  ccr: {
    fetch: () => ccrAccountService.getAllAccounts(),
    getOne: (id) => ccrAccountService.getAccount(id),
    opts: {}
  }
}

// 通用辅助函数
const normalizeBoolean = (value) => value === true || value === 'true'

const isRateLimitedFlag = (status) => {
  if (!status) return false
  if (typeof status === 'string') return status === 'limited'
  if (typeof status === 'object') return status.isRateLimited === true
  return false
}

// 账户状态分类（与 dashboard.js countAccountStats 一致）
const classifyAccount = (acc, opts = {}) => {
  const { isStringType = false, checkGeminiRateLimit = false, isDroid = false } = opts

  const isActive = isDroid
    ? normalizeBoolean(acc.isActive)
    : isStringType
      ? acc.isActive === 'true' ||
        acc.isActive === true ||
        (!acc.isActive && acc.isActive !== 'false' && acc.isActive !== false)
      : acc.isActive
  const isBlocked = acc.status === 'blocked' || acc.status === 'unauthorized'
  const isSchedulable = isDroid
    ? normalizeBoolean(acc.schedulable)
    : isStringType
      ? acc.schedulable !== 'false' && acc.schedulable !== false
      : acc.schedulable !== false
  const isRateLimited = checkGeminiRateLimit
    ? acc.rateLimitStatus === 'limited' ||
      (acc.rateLimitStatus && acc.rateLimitStatus.isRateLimited)
    : isRateLimitedFlag(acc.rateLimitStatus)

  if (!isActive || isBlocked) return 'abnormal'
  if (!isSchedulable) return 'paused'
  if (isRateLimited) return 'rateLimited'
  return 'normal'
}

// 敏感字段黑名单
const SENSITIVE_FIELDS = new Set([
  'accessToken',
  'refreshToken',
  'sessionKey',
  'cookie',
  'cookies',
  'token',
  'apiKey',
  'secretKey',
  'credentials',
  'awsAccessKeyId',
  'awsSecretAccessKey',
  'password',
  'hashedToken',
  'encryptedAccessToken',
  'encryptedRefreshToken',
  'encryptedSessionKey',
  'encryptedCookie',
  'encryptedApiKey',
  'encryptedCredentials'
])

// 剥离敏感字段
const sanitizeAccount = (acc) => {
  const result = {}
  for (const [key, value] of Object.entries(acc)) {
    if (!SENSITIVE_FIELDS.has(key)) {
      result[key] = value
    }
  }
  return result
}

// 📊 查询指定平台的账户状态
router.get('/accounts/status', authenticateAgentToken, async (req, res) => {
  try {
    const { platform } = req.query

    if (!platform) {
      return res.status(400).json({
        error: 'Missing platform parameter',
        message: 'Please specify a platform',
        availablePlatforms: Object.keys(PLATFORM_FETCHERS)
      })
    }

    const fetcher = PLATFORM_FETCHERS[platform]
    if (!fetcher) {
      return res.status(400).json({
        error: 'Invalid platform',
        message: `Unknown platform: ${platform}`,
        availablePlatforms: Object.keys(PLATFORM_FETCHERS)
      })
    }

    const accounts = await fetcher.fetch()
    const stats = { normal: 0, abnormal: 0, paused: 0, rateLimited: 0 }
    const accountSummaries = []

    for (const acc of accounts) {
      const classification = classifyAccount(acc, fetcher.opts)
      stats[classification]++

      accountSummaries.push({
        ...sanitizeAccount(acc),
        _classification: classification
      })
    }

    return res.json({
      success: true,
      data: {
        platform,
        total: accounts.length,
        ...stats,
        accounts: accountSummaries
      }
    })
  } catch (error) {
    logger.error('Failed to get account status:', error)
    return res.status(500).json({
      error: 'Failed to get account status',
      message: error.message
    })
  }
})

// 🔍 查询指定账户的详细状态和用量
router.get('/accounts/:id', authenticateAgentToken, async (req, res) => {
  try {
    const { id } = req.params
    const { platform } = req.query

    if (!platform) {
      return res.status(400).json({
        error: 'Missing platform parameter',
        message: 'Please specify a platform',
        availablePlatforms: Object.keys(PLATFORM_FETCHERS)
      })
    }

    const fetcher = PLATFORM_FETCHERS[platform]
    if (!fetcher) {
      return res.status(400).json({
        error: 'Invalid platform',
        message: `Unknown platform: ${platform}`,
        availablePlatforms: Object.keys(PLATFORM_FETCHERS)
      })
    }

    const account = await fetcher.getOne(id)
    if (!account) {
      return res.status(404).json({
        error: 'Account not found',
        message: `No account found with id: ${id} on platform: ${platform}`
      })
    }

    const classification = classifyAccount(account, fetcher.opts)
    const usage = await redis.getAccountUsageStats(id)

    return res.json({
      success: true,
      data: {
        account: {
          ...sanitizeAccount(account),
          _classification: classification
        },
        usage
      }
    })
  } catch (error) {
    logger.error('Failed to get account detail:', error)
    return res.status(500).json({
      error: 'Failed to get account detail',
      message: error.message
    })
  }
})

module.exports = router

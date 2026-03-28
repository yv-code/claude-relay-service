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
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')

const router = express.Router()

// 平台到获取函数的映射
// accountType: 对应 upstreamErrorHelper 中 temp_unavailable 键使用的类型标识
const PLATFORM_FETCHERS = {
  claude: {
    fetch: () => claudeAccountService.getAllAccounts(),
    getOne: (id) => claudeAccountService.getAccount(id),
    accountType: 'claude-official',
    opts: {}
  },
  'claude-console': {
    fetch: () => claudeConsoleAccountService.getAllAccounts(),
    getOne: (id) => claudeConsoleAccountService.getAccount(id),
    accountType: 'claude-console',
    opts: {}
  },
  gemini: {
    fetch: () => geminiAccountService.getAllAccounts(),
    getOne: (id) => geminiAccountService.getAccount(id),
    accountType: 'gemini',
    opts: { checkGeminiRateLimit: true }
  },
  'gemini-api': {
    fetch: () => geminiApiAccountService.getAllAccounts(true),
    getOne: (id) => geminiApiAccountService.getAccount(id),
    accountType: 'gemini-api',
    opts: { isStringType: true }
  },
  openai: {
    fetch: () => openaiAccountService.getAllAccounts(),
    getOne: (id) => openaiAccountService.getAccount(id),
    accountType: 'openai',
    opts: { isStringType: true }
  },
  'openai-responses': {
    fetch: () => openaiResponsesAccountService.getAllAccounts(true),
    getOne: (id) => openaiResponsesAccountService.getAccount(id),
    accountType: 'openai-responses',
    opts: { isStringType: true }
  },
  'azure-openai': {
    fetch: () => azureOpenaiAccountService.getAllAccounts(),
    getOne: (id) => azureOpenaiAccountService.getAccount(id),
    accountType: 'azure-openai',
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
    accountType: 'bedrock',
    opts: {}
  },
  droid: {
    fetch: () => droidAccountService.getAllAccounts(),
    getOne: (id) => droidAccountService.getAccount(id),
    accountType: 'droid',
    opts: { isDroid: true }
  },
  ccr: {
    fetch: () => ccrAccountService.getAllAccounts(),
    getOne: (id) => ccrAccountService.getAccount(id),
    accountType: 'ccr',
    opts: {}
  }
}

// 通用辅助函数
const normalizeBoolean = (value) => value === true || value === 'true'

const isRateLimitedFlag = (status) => {
  if (!status) {
    return false
  }
  if (typeof status === 'string') {
    return status === 'limited'
  }
  if (typeof status === 'object') {
    return status.isRateLimited === true
  }
  return false
}

// 账户状态分类（扩展自 dashboard.js countAccountStats）
// tempUnavailableInfo: 来自 upstreamErrorHelper.getAllTempUnavailable() 的临时不可用信息
const classifyAccount = (acc, opts = {}, tempUnavailableInfo = null) => {
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

  if (!isActive || isBlocked) {
    return 'abnormal'
  }
  if (!isSchedulable) {
    return 'paused'
  }
  if (tempUnavailableInfo) {
    return 'tempUnavailable'
  }
  if (isRateLimited) {
    return 'rateLimited'
  }
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

// 📋 查询指定平台的账户列表（仅 id 和启用状态）
router.get('/accounts', authenticateAgentToken, async (req, res) => {
  try {
    const { platform } = req.query

    if (!platform) {
      return res.status(400).json({
        success: false,
        message: 'Please specify a platform',
        availablePlatforms: Object.keys(PLATFORM_FETCHERS)
      })
    }

    const fetcher = PLATFORM_FETCHERS[platform]
    if (!fetcher) {
      return res.status(400).json({
        success: false,
        message: `Unknown platform: ${platform}`,
        availablePlatforms: Object.keys(PLATFORM_FETCHERS)
      })
    }

    const accounts = await fetcher.fetch()
    const list = accounts.map((acc) => ({
      id: acc.id,
      name: acc.name || acc.email || acc.accountName || null,
      isActive: normalizeBoolean(acc.isActive)
    }))

    return res.json({
      success: true,
      data: {
        platform,
        total: list.length,
        accounts: list
      }
    })
  } catch (error) {
    logger.error('Failed to get account list:', error)
    return res.status(500).json({
      success: false,
      message: error.message
    })
  }
})

// 📊 查询指定平台的账户状态
router.get('/accounts/status', authenticateAgentToken, async (req, res) => {
  try {
    const { platform } = req.query

    if (!platform) {
      return res.status(400).json({
        success: false,
        message: 'Please specify a platform',
        availablePlatforms: Object.keys(PLATFORM_FETCHERS)
      })
    }

    const fetcher = PLATFORM_FETCHERS[platform]
    if (!fetcher) {
      return res.status(400).json({
        success: false,
        message: `Unknown platform: ${platform}`,
        availablePlatforms: Object.keys(PLATFORM_FETCHERS)
      })
    }

    const [accounts, allTempUnavailable] = await Promise.all([
      fetcher.fetch(),
      upstreamErrorHelper.getAllTempUnavailable()
    ])
    const stats = { normal: 0, abnormal: 0, paused: 0, rateLimited: 0, tempUnavailable: 0 }
    const accountSummaries = []

    for (const acc of accounts) {
      const tuKey = `${fetcher.accountType}:${acc.id}`
      const tuInfo = allTempUnavailable[tuKey] || null
      const classification = classifyAccount(acc, fetcher.opts, tuInfo)
      stats[classification]++

      const summary = {
        ...sanitizeAccount(acc),
        _classification: classification
      }
      if (tuInfo) {
        summary._tempUnavailable = {
          statusCode: tuInfo.statusCode,
          errorType: tuInfo.errorType,
          markedAt: tuInfo.markedAt,
          remainingSeconds: tuInfo.remainingSeconds,
          cooldownSeconds: tuInfo.cooldownSeconds,
          expiresAt: tuInfo.expiresAt
        }
      }
      accountSummaries.push(summary)
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
      success: false,
      message: error.message
    })
  }
})

// 🔍 查询指定账户的详细状态和用量
router.get('/accounts/:id', authenticateAgentToken, async (req, res) => {
  try {
    const { id } = req.params

    // 遍历所有平台查找账户（ID 全局唯一）
    let account = null
    let matchedPlatform = null
    let matchedOpts = {}

    for (const [platform, fetcher] of Object.entries(PLATFORM_FETCHERS)) {
      const result = await fetcher.getOne(id)
      if (result) {
        account = result
        matchedPlatform = platform
        matchedOpts = fetcher.opts
        break
      }
    }

    if (!account) {
      return res.status(404).json({
        success: false,
        message: `No account found with id: ${id}`
      })
    }

    const matchedFetcher = PLATFORM_FETCHERS[matchedPlatform]
    const allTempUnavailable = await upstreamErrorHelper.getAllTempUnavailable()
    const tuKey = `${matchedFetcher.accountType}:${id}`
    const tuInfo = allTempUnavailable[tuKey] || null

    const classification = classifyAccount(account, matchedOpts, tuInfo)
    const usage = await redis.getAccountUsageStats(id)

    const accountData = {
      ...sanitizeAccount(account),
      _classification: classification
    }
    if (tuInfo) {
      accountData._tempUnavailable = {
        statusCode: tuInfo.statusCode,
        errorType: tuInfo.errorType,
        markedAt: tuInfo.markedAt,
        remainingSeconds: tuInfo.remainingSeconds,
        cooldownSeconds: tuInfo.cooldownSeconds,
        expiresAt: tuInfo.expiresAt
      }
    }

    return res.json({
      success: true,
      data: {
        platform: matchedPlatform,
        account: accountData,
        usage
      }
    })
  } catch (error) {
    logger.error('Failed to get account detail:', error)
    return res.status(500).json({
      success: false,
      message: error.message
    })
  }
})

module.exports = router

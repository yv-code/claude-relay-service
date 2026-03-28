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
const config = require('../../../config/config')
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

// ============================================
// Key Usage 查询辅助函数
// ============================================

// 解析时区字符串 "+08:00" / "-05:00" → 小时偏移量
const parseTimezoneOffset = (tz) => {
  const match = tz.match(/^([+-])(\d{2}):(\d{2})$/)
  if (!match) return null
  const sign = match[1] === '+' ? 1 : -1
  return sign * (parseInt(match[2]) + parseInt(match[3]) / 60)
}

// 解析 "YYYY-MM-DD HH:mm" + 时区偏移 → UTC Date
const parseTimeInTimezone = (timeStr, offsetHours) => {
  const match = timeStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/)
  if (!match) return null
  const [, y, m, d, h, min] = match
  const utcEquiv = new Date(
    Date.UTC(parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(h), parseInt(min), 0, 0)
  )
  return new Date(utcEquiv.getTime() - offsetHours * 3600000)
}

// Date → "YYYY-MM-DD"（使用 UTC 方法）
const formatDateUTC = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

// UTC Date → "YYYY-MM-DD HH:mm"（指定时区）
const formatTimeInTimezone = (d, offsetHours) => {
  const local = new Date(d.getTime() + offsetHours * 3600000)
  return `${formatDateUTC(local)} ${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
}

// 构建查询计划：确定每个日期用 hourly 还是 daily 查询
const buildQueryPlan = (dates, startDate, endDate, startHour, endHour, hourlyAvailableFromDate) => {
  const plan = []

  for (const date of dates) {
    const isFirst = date === startDate
    const isLast = date === endDate

    let fromHour = isFirst ? startHour : 0
    let toHour = isLast ? endHour : 23

    // 完整天 → 直接用 daily
    if (fromHour === 0 && toHour === 23) {
      plan.push({ type: 'daily', date })
      continue
    }

    // 部分天但小时数据已过期 → 回退到 daily
    if (date < hourlyAvailableFromDate) {
      plan.push({ type: 'daily-fallback', date })
      continue
    }

    for (let h = fromHour; h <= toHour; h++) {
      plan.push({ type: 'hourly', date, hour: h })
    }
  }

  return plan
}

// 📊 查询多 Key 在指定时间区间的用量
router.post('/keys/usage', authenticateAgentToken, async (req, res) => {
  try {
    const { keys, tag, startTime, endTime, timezone = '+08:00' } = req.body

    // keys 和 tag 至少提供一个
    const hasKeys = Array.isArray(keys) && keys.length > 0
    const hasTag = typeof tag === 'string' && tag.trim().length > 0
    if (!hasKeys && !hasTag) {
      return res.status(400).json({
        success: false,
        message: 'At least one of keys or tag is required'
      })
    }

    // 解析调用者时区
    const callerOffset = parseTimezoneOffset(timezone)
    if (callerOffset === null) {
      return res.status(400).json({
        success: false,
        message: `Invalid timezone format: ${timezone}, expected format like +08:00 or -05:00`
      })
    }

    const now = new Date()
    const serverOffset = config.system.timezoneOffset || 8

    // 解析起止时间 → UTC
    let startUTC, endUTC
    if (startTime) {
      startUTC = parseTimeInTimezone(startTime, callerOffset)
      if (!startUTC) {
        return res.status(400).json({
          success: false,
          message: `Invalid startTime format: ${startTime}, expected YYYY-MM-DD HH:mm`
        })
      }
    } else {
      // 默认：调用者时区的当天 00:00
      const callerNow = new Date(now.getTime() + callerOffset * 3600000)
      callerNow.setUTCHours(0, 0, 0, 0)
      startUTC = new Date(callerNow.getTime() - callerOffset * 3600000)
    }

    if (endTime) {
      endUTC = parseTimeInTimezone(endTime, callerOffset)
      if (!endUTC) {
        return res.status(400).json({
          success: false,
          message: `Invalid endTime format: ${endTime}, expected YYYY-MM-DD HH:mm`
        })
      }
    } else {
      // 默认：调用者时区的当天 23:59
      const callerNow = new Date(now.getTime() + callerOffset * 3600000)
      callerNow.setUTCHours(23, 59, 59, 999)
      endUTC = new Date(callerNow.getTime() - callerOffset * 3600000)
    }

    if (startUTC >= endUTC) {
      return res.status(400).json({
        success: false,
        message: 'startTime must be before endTime'
      })
    }

    // Step 0: 通过 tag 解析 keyIds，与 keys 取并集
    const client = redis.getClientSafe()
    const allKeyInputs = new Set(hasKeys ? keys : [])

    if (hasTag) {
      const tagMembers = await client.smembers(`apikey:tag:${tag.trim()}`)
      for (const keyId of tagMembers) {
        allKeyInputs.add(keyId)
      }
    }

    // tag 查不到任何 key 且没有 keys 参数 → 返回空结果
    if (allKeyInputs.size === 0) {
      return res.json({
        success: true,
        data: {
          startTime: startTime || formatTimeInTimezone(startUTC, callerOffset),
          endTime: endTime || formatTimeInTimezone(endUTC, callerOffset),
          timezone,
          keys: {},
          total: {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
            allTokens: 0,
            cost: 0,
            realCost: 0
          },
          notFound: []
        }
      })
    }

    // Step 1: 解析 key 标识 → keyId
    const keyInputs = [...allKeyInputs]
    const resolvedKeys = {} // keyId → name
    const notFound = []

    // 先按 keyId 查找
    const idCheckPipeline = client.pipeline()
    for (const k of keyInputs) {
      idCheckPipeline.hget(`apikey:${k}`, 'name')
    }
    const idCheckResults = await idCheckPipeline.exec()

    const unresolvedValues = []
    for (let i = 0; i < keyInputs.length; i++) {
      const name = idCheckResults[i]?.[1]
      if (name !== null && name !== undefined) {
        resolvedKeys[keyInputs[i]] = name
      } else {
        unresolvedValues.push(keyInputs[i])
      }
    }

    // 未命中的按 name 查找（通过 apikey:idx:name 索引）
    for (const value of unresolvedValues) {
      const lowerName = value.toLowerCase()
      const members = await client.zrangebylex(
        'apikey:idx:name',
        `[${lowerName}\x00`,
        `[${lowerName}\x00\xff`
      )
      if (members.length > 0) {
        const keyId = members[0].split('\x00')[1]
        if (keyId) {
          const actualName = await client.hget(`apikey:${keyId}`, 'name')
          resolvedKeys[keyId] = actualName || value
        } else {
          notFound.push(value)
        }
      } else {
        notFound.push(value)
      }
    }

    // Step 2: 构建服务端时区的日期/小时范围
    const startServerLocal = new Date(startUTC.getTime() + serverOffset * 3600000)
    const endServerLocal = new Date(endUTC.getTime() + serverOffset * 3600000)

    const startDate = formatDateUTC(startServerLocal)
    const endDate = formatDateUTC(endServerLocal)
    const startHour = startServerLocal.getUTCHours()
    const endHour = endServerLocal.getUTCHours()

    // 生成日期列表
    const dates = []
    const cursor = new Date(startServerLocal)
    cursor.setUTCHours(0, 0, 0, 0)
    const endDay = new Date(endServerLocal)
    endDay.setUTCHours(0, 0, 0, 0)
    while (cursor <= endDay) {
      dates.push(formatDateUTC(cursor))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }

    // 小时数据可用截止（服务端时区的 7 天前日期）
    const sevenDaysAgoServer = new Date(now.getTime() + serverOffset * 3600000 - 7 * 86400000)
    const hourlyAvailableFromDate = formatDateUTC(sevenDaysAgoServer)

    // 构建查询计划
    const queryPlan = buildQueryPlan(
      dates,
      startDate,
      endDate,
      startHour,
      endHour,
      hourlyAvailableFromDate
    )

    // 计算每个 key 的 pipeline 命令数
    let commandsPerKey = 0
    for (const item of queryPlan) {
      commandsPerKey += item.type === 'hourly' ? 2 : 3
    }

    // Step 3: 用 pipeline 批量查询所有 key 的用量
    const keyIds = Object.keys(resolvedKeys)
    const pipeline = client.pipeline()

    for (const keyId of keyIds) {
      for (const item of queryPlan) {
        if (item.type === 'hourly') {
          const hourStr = `${item.date}:${String(item.hour).padStart(2, '0')}`
          pipeline.hgetall(`usage:hourly:${keyId}:${hourStr}`)
          pipeline.get(`usage:cost:hourly:${keyId}:${hourStr}`)
        } else {
          pipeline.hgetall(`usage:daily:${keyId}:${item.date}`)
          pipeline.get(`usage:cost:daily:${keyId}:${item.date}`)
          pipeline.get(`usage:cost:real:daily:${keyId}:${item.date}`)
        }
      }
    }

    const results = keyIds.length > 0 && commandsPerKey > 0 ? await pipeline.exec() : []

    // Step 4: 汇总
    const keysResult = {}
    const total = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      allTokens: 0,
      cost: 0,
      realCost: 0
    }

    for (let k = 0; k < keyIds.length; k++) {
      const keyId = keyIds[k]
      const baseOffset = k * commandsPerKey
      let resultIdx = baseOffset
      let dailyFallback = false

      const keyStats = {
        name: resolvedKeys[keyId],
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        allTokens: 0,
        cost: 0,
        realCost: 0
      }

      for (const item of queryPlan) {
        if (item.type === 'hourly') {
          const usage = results[resultIdx]?.[1] || {}
          const cost = parseFloat(results[resultIdx + 1]?.[1] || 0)
          keyStats.requests += parseInt(usage.requests || 0)
          keyStats.inputTokens += parseInt(usage.inputTokens || 0)
          keyStats.outputTokens += parseInt(usage.outputTokens || 0)
          keyStats.cacheCreateTokens += parseInt(usage.cacheCreateTokens || 0)
          keyStats.cacheReadTokens += parseInt(usage.cacheReadTokens || 0)
          keyStats.allTokens += parseInt(usage.allTokens || 0)
          keyStats.cost += cost
          keyStats.realCost += cost // 小时级别无独立 realCost
          resultIdx += 2
        } else {
          if (item.type === 'daily-fallback') dailyFallback = true
          const usage = results[resultIdx]?.[1] || {}
          const cost = parseFloat(results[resultIdx + 1]?.[1] || 0)
          const realCost = parseFloat(results[resultIdx + 2]?.[1] || 0)
          keyStats.requests += parseInt(usage.requests || 0)
          keyStats.inputTokens += parseInt(usage.inputTokens || 0)
          keyStats.outputTokens += parseInt(usage.outputTokens || 0)
          keyStats.cacheCreateTokens += parseInt(usage.cacheCreateTokens || 0)
          keyStats.cacheReadTokens += parseInt(usage.cacheReadTokens || 0)
          keyStats.allTokens += parseInt(usage.allTokens || 0)
          keyStats.cost += cost
          keyStats.realCost += realCost
          resultIdx += 3
        }
      }

      keyStats.cost = Math.round(keyStats.cost * 100) / 100
      keyStats.realCost = Math.round(keyStats.realCost * 100) / 100
      keyStats.dailyFallback = dailyFallback
      keysResult[keyId] = keyStats

      total.requests += keyStats.requests
      total.inputTokens += keyStats.inputTokens
      total.outputTokens += keyStats.outputTokens
      total.cacheCreateTokens += keyStats.cacheCreateTokens
      total.cacheReadTokens += keyStats.cacheReadTokens
      total.allTokens += keyStats.allTokens
      total.cost += keyStats.cost
      total.realCost += keyStats.realCost
    }

    total.cost = Math.round(total.cost * 100) / 100
    total.realCost = Math.round(total.realCost * 100) / 100

    return res.json({
      success: true,
      data: {
        startTime: startTime || formatTimeInTimezone(startUTC, callerOffset),
        endTime: endTime || formatTimeInTimezone(endUTC, callerOffset),
        timezone,
        keys: keysResult,
        total,
        notFound
      }
    })
  } catch (error) {
    logger.error('Failed to query key usage:', error)
    return res.status(500).json({
      success: false,
      message: error.message
    })
  }
})

module.exports = router

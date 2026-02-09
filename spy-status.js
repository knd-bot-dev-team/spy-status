/**
 * 桌面状态查询插件（多人版）
 * 调用 Web/server.js 的接口：/api/names、/api/current-status?name=xxx
 * 指令与数据对应：时间雨核→雨核，时间音落→音落，时间夜合→夜合，时间皮梦→皮梦；时间开发团队→雨核+音落+夜合+皮梦。每人展示与皮梦一致：手机/电脑各一块，每块只展示一条最新。
 *
 * 配置：
 *   - SPY_API_BASE：雨核/音落/夜合 的 Web 服务端地址，默认 http://127.0.0.1:3100
 *   - SPY_PIMENG_API_BASE：皮梦数据源，与 视奸皮梦.js 的 API_URL 一致，默认 https://shijian.lyxmb.com
 */

import plugin from '../../lib/plugins/plugin.js'
import common from '../../lib/common/common.js'
import cfg from '../../lib/config/config.js'

const CONFIG = {
  API_BASE: process.env.SPY_API_BASE || 'http://127.0.0.1:3100',
  PIMENG_API_BASE: (process.env.SPY_PIMENG_API_BASE || 'https://shijian.lyxmb.com').replace(/\/$/, ''),
  TIMEOUT: 10000,
  PER_PERSON_LIMIT: 5,
  CACHE_EXPIRE_TIME: 8000,
}

/** 从 config 加载 spy-status 配置（合并默认与用户配置） */
function loadSpyStatusConfig() {
  try {
    const def = cfg.getdefSet('spy-status') || {}
    const user = cfg.getConfig('spy-status') || {}
    return { ...def, ...user }
  } catch (e) {
    return cfg.getdefSet('spy-status') || {}
  }
}
/** 皮梦设备 ID，与 视奸皮梦.js 一致 */
const PIMENG_PHONE_MACHINE = 'pimeng-iq13'
const PIMENG_PC_MACHINE = 'pimeng-pc'
/** 手机不输出到消息的应用（系统/输入法等） */
const NOISE_APPS = ['生物识别', '系统 UI', 'Android 系统', '系统界面', '搜狗输入法小米版', '指纹UI', 'One UI 主屏幕','安全服务']
/** 仅当数据只有这些时显示「熄屏」 */
const SCREEN_OFF_APPS = ['生物识别', '系统 UI', 'Android 系统', '指纹UI', 'One UI 主屏幕']
/** 电脑数据超过此时长未更新视为无活动（用于「好像睡着了」判断），毫秒 */
const PC_STALE_MS = 4 * 60 * 60 * 1000
/** 雨核手机出现此关键词时显示「在推制霸呢」（包含匹配） */
const RAINCORE_ZHIBA_KEYWORD = '范式：起源'

const cache = {
  byNames: {},
  timestamp: 0,
}

const fetchWithTimeout = (url, opts = {}, ms = CONFIG.TIMEOUT) =>
  Promise.race([
    fetch(url, { ...opts, signal: AbortSignal.timeout(ms) }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Request timeout')), ms)
    ),
  ])

export class SpyStatus extends plugin {
  constructor() {
    const spyCfg = loadSpyStatusConfig()
    const persons = Array.isArray(spyCfg.persons) ? spyCfg.persons : []
    const teamTrigger = spyCfg.teamTrigger || '时间开发团队'
    const triggers = [...persons.map((p) => (p && p.trigger) || '').filter(Boolean), teamTrigger, '时间所有人']
    const reg = triggers.length > 0 ? new RegExp(`^(${triggers.join('|')})\\s*$`) : /^$/
    super({
      name: 'spy-status',
      dsc: '查询桌面状态（多人，对接 Web/server.js）；人物与指令在 config/config/spy-status.yaml 配置',
      event: 'message',
      priority: 5000,
      rule: [{ reg, fnc: 'query' }],
    })
    this.spyStatusCfg = spyCfg
  }

  getApiUrl(path, params = {}, base) {
    const b = (base != null ? base : CONFIG.API_BASE).replace(/\/$/, '')
    const q = new URLSearchParams(params).toString()
    return q ? `${b}${path}?${q}` : `${b}${path}`
  }

  async fetchNames() {
    const url = this.getApiUrl('/api/names')
    const res = await fetchWithTimeout(url)
    if (!res.ok) throw new Error('获取名单失败')
    const data = await res.json()
    return (data && data.names && Array.isArray(data.names)) ? data.names : []
  }

  async fetchStatusByName(name, limit = CONFIG.PER_PERSON_LIMIT, apiBase) {
    const base = apiBase != null ? apiBase : CONFIG.API_BASE
    const url = this.getApiUrl('/api/current-status', { name, limit }, base)
    const res = await fetchWithTimeout(url)
    if (!res.ok) throw new Error(`请求失败: HTTP ${res.status}`)
    const list = await res.json()
    return Array.isArray(list) ? list : []
  }

  /** 是否为手机/移动端设备（不展示窗口标题，仅应用+时间） */
  isPhoneDevice(machine) {
    if (!machine) return false
    const m = String(machine).toLowerCase()
    return /phone|android|mobile|iq13|iqoo/i.test(m)
  }

  /** 从 event 取应用名（window_title 首段或 app），用于判断。有包名时只取「 - 」前一段，精确匹配用。 */
  getAppNameFromEvent(ev) {
    if (!ev) return ''
    const wt = (ev.window_title || '').trim()
    if (wt) {
      const first = wt.split(' - ')[0]
      if (first != null) return first.trim()
    }
    const app = (ev.app || '').trim()
    if (app) {
      const first = app.split(' - ')[0]
      if (first != null) return first.trim()
    }
    return ''
  }

  /** 手机展示用：只取应用名，屏蔽包名（不输出「 - 」后的内容） */
  getDisplayAppNameForPhone(ev) {
    if (!ev) return '-'
    const raw = (ev.window_title || ev.app || '').trim()
    const first = raw.split(' - ')[0]
    return (first != null && first.trim() !== '') ? first.trim() : '-'
  }

  /** 是否为不输出的噪音应用（精确匹配：应用名与列表项完全一致） */
  isNoiseApp(appName) {
    return NOISE_APPS.some((a) => (appName || '').trim() === a)
  }

  /** 是否为熄屏类（精确匹配：仅此类时显示「熄屏」） */
  isScreenOffApp(appName) {
    return SCREEN_OFF_APPS.some((a) => (appName || '').trim() === a)
  }

  /** 电脑无数据或数据超过指定时长未更新 */
  isPcStale(pcData, maxAgeMs = PC_STALE_MS) {
    if (!pcData) return true
    const t = pcData.access_time ? new Date(pcData.access_time).getTime() : 0
    return Date.now() - t > maxAgeMs
  }

  /** 手机仅熄屏类且（电脑无数据或电脑 4h 未更新）→ 显示「好像睡着了」 */
  isAsleepCondition(phoneData, pcData) {
    if (!phoneData) return false
    const appName = this.getAppNameFromEvent(phoneData)
    if (!this.isScreenOffApp(appName)) return false
    return this.isPcStale(pcData)
  }

  /** event 的 window_title 或 app 是否包含某关键词（用于制霸等包含匹配） */
  eventContainsKeyword(ev, keyword) {
    if (!ev || !keyword) return false
    const wt = (ev.window_title || '').includes(keyword)
    const app = (ev.app || '').includes(keyword)
    return wt || app
  }

  fmtTime(ev) {
    if (!ev || !ev.access_time) return '--'
    const t = new Date(ev.access_time)
    return `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  }

  /** 雨核/音落/夜合：按皮梦逻辑，手机/电脑各一块，每块只展示一条最新 */
  formatPersonBlock(name, phoneData, pcData) {
    let phoneBlock
    if (!phoneData) {
      phoneBlock = ['====== 手机状态 ======', '  暂无数据', ''].join('\n')
    } else {
      const appName = this.getAppNameFromEvent(phoneData)
      if (this.isNoiseApp(appName)) {
        const text = this.isScreenOffApp(appName) ? '熄屏' : '暂无数据'
        phoneBlock = ['====== 手机状态 ======', `  ${text}`, `来自：${name} の 手机`, ''].join('\n')
      } else {
        const app = this.getDisplayAppNameForPhone(phoneData)
        const content = (app === '游戏助推器')
          ? '在打游戏，但是采集不到在打什么神秘游戏'
          : `▶应用：${app}`
        phoneBlock = [
          '====== 手机状态 ======',
          content,
          `时间：${this.fmtTime(phoneData)}`,
          `来自：${name} の 手机`,
          ''
        ].join('\n')
      }
    }
    let pcBlock
    if (!pcData) {
      pcBlock = ['====== 电脑状态 ======', '  暂无数据', `来自：${name} の PC`].join('\n')
    } else {
      const fullWindowTitle = pcData.window_title || '未知窗口'
      const parts = fullWindowTitle.split(' - ')
      const appName = parts[0] || '未知'
      pcBlock = [
        '====== 电脑状态 ======',
        `💻${name}的电脑正在运行：`,
        `▶应用：${appName}\n▶窗口标题：${fullWindowTitle}`,
        `时间：${this.fmtTime(pcData)}`,
        `来自：${name} の PC`
      ].join('\n')
    }
    return phoneBlock + '\n' + pcBlock
  }

  formatMessageByPerson(name, events) {
    if (!events || events.length === 0) {
      return `【${name}】\n  暂无记录\n`
    }
    if (name === '皮梦') {
      const phoneData = events.find((e) => e.machine === PIMENG_PHONE_MACHINE) || null
      const pcData = events.find((e) => e.machine === PIMENG_PC_MACHINE) || null
      if (this.isAsleepCondition(phoneData, pcData)) {
        return `【${name}】\n  ${name}好像睡着了呢\n`
      }
      return this.formatPimengMessage(phoneData, pcData)
    }
    const phoneData = events.find((e) => this.isPhoneDevice(e.machine)) || null
    const pcData = events.find((e) => !this.isPhoneDevice(e.machine)) || null
    if (this.isAsleepCondition(phoneData, pcData)) {
      return `【${name}】\n  ${name}好像睡着了呢\n`
    }
    let msg = `【${name}】\n` + this.formatPersonBlock(name, phoneData, pcData)
    if (name === '雨核' && phoneData && this.eventContainsKeyword(phoneData, RAINCORE_ZHIBA_KEYWORD)) {
      msg += '\n雨核在推制霸呢...不要打扰他'
    }
    return msg
  }

  /**
   * 皮梦展示格式与 视奸皮梦.js 一致：手机/电脑分块，音乐与应用名映射
   * phoneData/pcData 为单条 event（含 window_title, access_time 等），可为 null 表示暂无
   */
  formatPimengMessage(phoneData, pcData) {
    const fmtTime = (ev) => this.fmtTime(ev)
    let phoneBlock
    if (!phoneData) {
      phoneBlock = ['====== 手机状态 ======', '  暂无数据', ''].join('\n')
    } else {
      const appNamePimeng = this.getAppNameFromEvent(phoneData)
      if (this.isNoiseApp(appNamePimeng)) {
        const text = this.isScreenOffApp(appNamePimeng) ? '熄屏' : '暂无数据'
        phoneBlock = ['====== 手机状态 ======', `  ${text}`, '来自：皮梦 の iQOO13', ''].join('\n')
      } else {
        let phonePrefix, phoneContent
        const wt = phoneData.window_title || ''
        if (wt.startsWith('🎵')) {
          const fullTitle = wt.replace(/^🎵\s*/, '')
          const [appName, ...songParts] = fullTitle.split(' - ')
          const songName = songParts.join(' - ') || fullTitle
          phonePrefix = '🎵皮梦正在听音乐：'
          phoneContent = `▶曲目：${songName}\n▶用${appName || '未知应用'}听的`
        } else {
          const [appName] = wt.split(' - ')
          if (appName === '三角洲行动') phoneContent = '得吃'
          else if (['交互池', '系统桌面', '系统界面组件'].includes(appName)) phoneContent = `神秘应用（采集不准确）「${appName}」`
          else if (appName === '游戏魔盒') phoneContent = '在打游戏，但是采集不到在打什么神秘游戏'
          else if (appName === 'PiliPlus') phoneContent = '哔哩哔哩（第三方客户端）'
          else phoneContent = `▶应用：${appName || '未知应用'}`
          phonePrefix = '♿️皮梦正在'
        }
        phoneBlock = [
          '====== 手机状态 ======',
          phonePrefix,
          phoneContent,
          `时间：${fmtTime(phoneData)}`,
          '来自：皮梦 の iQOO13',
          ''
        ].join('\n')
      }
    }
    let pcBlock
    if (!pcData) {
      pcBlock = ['====== 电脑状态 ======', '  暂无数据', '来自：皮梦 の PC'].join('\n')
    } else {
      const fullWindowTitle = pcData.window_title || '未知窗口'
      const parts = fullWindowTitle.split(' - ')
      const appName = parts[0] || '未知'
      pcBlock = [
        '====== 电脑状态 ======',
        '💻皮梦的电脑正在运行：',
        `▶应用：${appName}\n▶窗口标题：${fullWindowTitle}`,
        `时间：${fmtTime(pcData)}`,
        '来自：皮梦 の PC'
      ].join('\n')
    }
    return phoneBlock + '\n' + pcBlock
  }

  /** 指令与名单映射：从 config 读取。时间所有人 不在此处返回，由 query 内从服务端 /api/names 拉取 */
  getNamesByTrigger(trigger) {
    const c = this.spyStatusCfg || loadSpyStatusConfig()
    if (trigger === '时间所有人') return null
    if (trigger === (c.teamTrigger || '时间开发团队')) {
      const names = Array.isArray(c.teamNames) ? c.teamNames : []
      return names.length > 0 ? names : null
    }
    const persons = Array.isArray(c.persons) ? c.persons : []
    const p = persons.find((x) => x && x.trigger === trigger)
    return p && p.name ? [p.name] : null
  }

  /** 某人是否使用独立 API 源（从 config 的 persons[].apiBase 读取） */
  getApiBaseForName(name) {
    const c = this.spyStatusCfg || loadSpyStatusConfig()
    const persons = Array.isArray(c.persons) ? c.persons : []
    const p = persons.find((x) => x && x.name === name)
    if (p && p.apiBase) return String(p.apiBase).replace(/\/$/, '')
    return CONFIG.API_BASE
  }

  async query() {
    this.spyStatusCfg = loadSpyStatusConfig()
    const c = this.spyStatusCfg
    const persons = Array.isArray(c.persons) ? c.persons : []
    const teamTrigger = c.teamTrigger || '时间开发团队'
    const triggers = [...persons.map((p) => (p && p.trigger) || '').filter(Boolean), teamTrigger]
    const reg = triggers.length > 0 ? new RegExp(`^(${triggers.join('|')})\\s*$`) : /^$/
    const raw = (this.e.msg || '').trim()
    const match = raw.match(reg)
    if (!match) return

    const trigger = match[1]
    let names
    if (trigger === '时间所有人') {
      try {
        names = await this.fetchNames()
      } catch (e) {
        logger.error('[spy-status] 时间所有人：获取名单失败', e && e.message)
        await this.e.reply('获取所有人名单失败，请确认服务端已启动且 ' + CONFIG.API_BASE + ' 可访问。')
        return
      }
      if (!names || names.length === 0) {
        await this.e.reply('服务端当前没有任何已配置的用户（group-map 为空）。')
        return
      }
    } else {
      names = this.getNamesByTrigger(trigger)
    }
    if (!names || !Array.isArray(names) || names.length === 0) {
      logger.warn('[spy-status] 未知指令:', trigger)
      return
    }

    const now = Date.now()
    const cacheKey = names.slice().sort().join(',')
    const cached = cache.byNames[cacheKey]
    if (cached && (now - cache.timestamp) < CONFIG.CACHE_EXPIRE_TIME) {
      if (Array.isArray(cached)) {
        const title = trigger === '时间所有人' ? '所有人状态' : (c.teamForwardTitle || '开发团队状态')
        const forwardMsg = await common.makeForwardMsg(this.e, cached, title)
        await this.e.reply(forwardMsg)
      } else {
        await this.e.reply(cached, true)
      }
      return
    }

    const blocks = []
    for (const name of names) {
      try {
        const apiBase = this.getApiBaseForName(name)
        const events = await this.fetchStatusByName(name, CONFIG.PER_PERSON_LIMIT, apiBase)
        blocks.push(this.formatMessageByPerson(name, events))
      } catch (e) {
        logger.warn('[spy-status] 查询失败:', name, e && e.message)
        blocks.push(`【${name}】\n  查询失败：${e && e.message}\n`)
      }
    }

    const isTeamQuery = trigger === (c.teamTrigger || '时间开发团队') || trigger === '时间所有人'
    const isForward = isTeamQuery && blocks.length > 0
    if (isForward) {
      const isDevTeam = trigger === (c.teamTrigger || '时间开发团队')
      const forwardBlocks = isDevTeam ? ['这是当前knd dev team成员状态', ...blocks] : blocks
      cache.byNames[cacheKey] = forwardBlocks
      cache.timestamp = now
      const title = trigger === '时间所有人' ? '所有人状态' : (c.teamForwardTitle || '开发团队状态')
      const forwardMsg = await common.makeForwardMsg(this.e, forwardBlocks, title)
      await this.e.reply(forwardMsg)
    } else {
      const msg = blocks.join('').trim() || '暂无数据'
      cache.byNames[cacheKey] = msg
      cache.timestamp = now
      await this.e.reply(msg, true)
    }
  }
}

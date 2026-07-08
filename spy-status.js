/**
 * 桌面状态查询插件（多人版）
 * 调用 Web/server.js 的接口：/api/names、/api/current-status?name=xxx、/api/today-events?name=xxx
 * 指令格式：xx在干嘛，如「雨核在干嘛」「皮梦在干嘛」「开发团队在干嘛」「所有人在干嘛」。团队由 config 的 teamTrigger/teamNames 决定。
 * 「看看xx今天做了什么」：拉取当日上传事件，按心跳间隔统计设备与应用使用时长。
 *
 * 配置：
 *   - SPY_API_BASE：音落/夜合 的 Web 服务端地址，默认 http://127.0.0.1:3100
 *   - SPY_STATUS_API_BASE：雨核/皮梦 的统一状态数据源，默认 https://shijian.07210700.xyz
 *   - heartbeatIntervalSeconds：心跳间隔（秒），用于今日统计时长计算，默认 60
 */

import plugin from '../../lib/plugins/plugin.js'
import common from '../../lib/common/common.js'
import cfg from '../../lib/config/config.js'

const CONFIG = {
  API_BASE: process.env.SPY_API_BASE || 'http://127.0.0.1:3100',
  STATUS_API_BASE: (process.env.SPY_STATUS_API_BASE || 'https://shijian.07210700.xyz').replace(/\/$/, ''),
  TIMEOUT: 10000,
  PER_PERSON_LIMIT: 5,
  CACHE_EXPIRE_TIME: 8000,
  HEARTBEAT_INTERVAL_SECONDS: 60,
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
const NOISE_APPS = ['生物识别', '系统 UI', 'Android 系统', '系统界面', '系统桌面', '搜狗输入法小米版', '指纹UI', 'One UI 主屏幕','安全服务']
/** 仅当数据只有这些时显示「熄屏」 */
const SCREEN_OFF_APPS = ['生物识别', '系统 UI', 'Android 系统', '系统桌面', '指纹UI', 'One UI 主屏幕']
/** 电脑数据超过此时长未更新视为无活动（用于「好像睡着了」判断），毫秒 */
const PC_STALE_MS = 4 * 60 * 60 * 1000
/** 雨核手机出现此关键词时显示「在推制霸呢」（包含匹配） */
const RAINCORE_ZHIBA_KEYWORD = '范式：起源'
/** 不展示电脑状态的人员（即便服务端有 PC 事件也直接忽略，确保消息不出现） */
const HIDE_PC_NAMES = ['音落', '夜合']

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
    const todayNames = [...new Set([...persons.map((p) => p && p.name).filter(Boolean), ...(Array.isArray(spyCfg.teamNames) ? spyCfg.teamNames : [])])]
    const regToday = todayNames.length > 0 ? new RegExp(`^看看(${todayNames.join('|')})今天做了什么\\s*$`) : /^$/
    super({
      name: 'spy-status',
      dsc: '查询桌面状态（多人，对接 Web/server.js）；人物与指令在 config/config/spy-status.yaml 配置',
      event: 'message',
      priority: 5000,
      rule: [{ reg: /^(.+?)在干嘛\s*$/, fnc: 'query' }, { reg: regToday, fnc: 'queryToday' }],
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

  /** 拉取某人当天上传的事件（需服务端实现 GET /api/today-events?name=xxx，返回 [{ machine, window_title, app, access_time }, ...]） */
  async fetchTodayEvents(name, apiBase) {
    const base = apiBase != null ? apiBase : CONFIG.API_BASE
    const url = this.getApiUrl('/api/today-events', { name }, base)
    const res = await fetchWithTimeout(url)
    if (!res.ok) throw new Error(`请求失败: HTTP ${res.status}`)
    const list = await res.json()
    return Array.isArray(list) ? list : []
  }

  /** 是否为手机/移动端设备（不展示窗口标题，仅应用+时间） */
  isPhoneDevice(machine) {
    if (!machine) return false
    const m = String(machine).toLowerCase()
    return /phone|android|mobile|iq13|iqoo|sanxing|yuhe/i.test(m)
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

  /**
   * 解析浏览器式窗口标题：多为「页面内容 - 附加 - 应用名」，取最后一段为应用、前面为窗口标题
   * 例如：xxx - 个人 - Microsoft​ Edge → 应用=Microsoft​ Edge，窗口标题=xxx - 个人
   */
  parseBrowserStyleTitle(fullTitle) {
    if (!fullTitle || typeof fullTitle !== 'string') return null
    const parts = fullTitle.split(' - ').map((p) => p.trim()).filter(Boolean)
    if (parts.length < 2) return null
    const appName = parts[parts.length - 1]
    const windowTitle = parts.slice(0, -1).join(' - ')
    return { appName, windowTitle }
  }

  /** 今日统计用：从 event 解析出用于分组的应用名（手机取应用名/音乐取应用，电脑取浏览器式最后一段或首段） */
  getAppNameForStats(ev, isPhone) {
    if (!ev) return '未知'
    const raw = (ev.window_title || ev.app || '').trim()
    const music = this.parseMusicWindowTitle(raw)
    if (music) return this.trimLeadingNoise(music.app) || '未知'
    if (isPhone) {
      const app = (raw.split(' - ')[0] || '').trim()
      return this.trimLeadingNoise(app) || '未知'
    }
    const browser = this.parseBrowserStyleTitle(raw)
    if (browser) return browser.appName.trim() || '未知'
    const first = (raw.split(' - ')[0] || '').trim()
    return first || '未知'
  }

  /** 秒数格式化为「x小时x分钟」 */
  formatDuration(seconds) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0 && m > 0) return `${h}小时${m}分钟`
    if (h > 0) return `${h}小时`
    if (m > 0) return `${m}分钟`
    return '不足1分钟'
  }

  /** 去掉字符串开头可能因编码损坏产生的乱码（ U+FFFD、孤立代理对）或音乐符号（🎶🎵） */
  trimLeadingNoise(s) {
    if (!s || typeof s !== 'string') return s
    return s.replace(/^[\uFFFD\s\uD800-\uDFFF]+/, '').trim()
  }

  /** 判断是否为音乐类窗口标题（🎶 或 🎵 开头），并解析出应用名与曲目 */
  parseMusicWindowTitle(fullTitle) {
    if (!fullTitle || typeof fullTitle !== 'string') return null
    const raw = fullTitle.trim()
    const isMusic = /^[\uFFFD\uD83C\uDFB5\uD83C\uDFB6🎶🎵]/.test(raw) || raw.startsWith('🎶') || raw.startsWith('🎵')
    if (!isMusic) return null
    const rest = this.trimLeadingNoise(raw)
    const sep = ' - '
    const idx = rest.indexOf(sep)
    if (idx === -1) return { app: this.trimLeadingNoise(rest) || '未知', song: this.trimLeadingNoise(rest) || '' }
    const app = this.trimLeadingNoise(rest.slice(0, idx)) || '未知'
    const song = this.trimLeadingNoise(rest.slice(idx + sep.length)) || ''
    return { app, song }
  }

  /** 是否为不输出的噪音应用（精确匹配：应用名与列表项完全一致） */
  isNoiseApp(appName) {
    return NOISE_APPS.some((a) => (appName || '').trim() === a)
  }

  /** 是否为熄屏类（精确匹配：仅此类时显示「熄屏」） */
  isScreenOffApp(appName) {
    return SCREEN_OFF_APPS.some((a) => (appName || '').trim() === a)
  }

  /** 当日使用统计中是否排除该事件（熄屏类、噪音应用不参与统计与展示） */
  isNoiseOrScreenOffForStats(ev, isPhone) {
    const appName = this.getAppNameForStats(ev, isPhone)
    return this.isNoiseApp(appName) || this.isScreenOffApp(appName)
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

  /** 雨核/音落/夜合：按皮梦逻辑，手机/电脑各一块，每块只展示一条最新；支持 🎶/🎵 音乐窗口解析为「在听什么歌」 */
  formatPersonBlock(name, phoneData, pcData, opts = {}) {
    const hidePc = !!opts.hidePc
    let phoneBlock
    if (!phoneData) {
      phoneBlock = ['====== 手机状态 ======', '  暂无数据', ''].join('\n')
    } else {
      const appName = this.getAppNameFromEvent(phoneData)
      if (this.isNoiseApp(appName)) {
        const text = this.isScreenOffApp(appName) ? '熄屏' : '暂无数据'
        phoneBlock = ['====== 手机状态 ======', `  ${text}`, `来自：${name} の 手机`, ''].join('\n')
      } else {
        const rawTitle = (phoneData.window_title || phoneData.app || '').trim()
        const music = this.parseMusicWindowTitle(rawTitle)
        let content
        if (music) {
          content = `🎵正在听：${music.song}\n▶应用：${music.app}`
        } else {
          const app = this.getDisplayAppNameForPhone(phoneData)
          content = (app === '游戏助推器')
            ? '在打游戏，但是采集不到在打什么神秘游戏'
            : `▶应用：${app}`
        }
        phoneBlock = [
          '====== 手机状态 ======',
          content,
          `更新时间：${this.fmtTime(phoneData)}`,
          `来自：${name} の 手机`,
          ''
        ].join('\n')
      }
    }

    if (hidePc) return phoneBlock

    let pcBlock
    if (!pcData) {
      pcBlock = ['====== 电脑状态 ======', '  暂无数据', `来自：${name} の PC`].join('\n')
    } else {
      const fullWindowTitle = pcData.window_title || '未知窗口'
      const music = this.parseMusicWindowTitle(fullWindowTitle)
      let pcContent
      if (music) {
        pcContent = `🎵正在听：${music.song}\n▶应用：${music.app}`
      } else {
        const browser = this.parseBrowserStyleTitle(fullWindowTitle)
        if (browser) {
          pcContent = `▶应用：${browser.appName}\n▶窗口标题：${browser.windowTitle}`
        } else {
          const parts = fullWindowTitle.split(' - ')
          const appName = parts[0] || '未知'
          pcContent = `▶应用：${appName}\n▶窗口标题：${fullWindowTitle}`
        }
      }
      pcBlock = [
        '====== 电脑状态 ======',
        `💻${name}的电脑正在运行：`,
        pcContent,
        `更新时间：${this.fmtTime(pcData)}`,
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
    const pcData = HIDE_PC_NAMES.includes(name) ? null : (events.find((e) => !this.isPhoneDevice(e.machine)) || null)
    if (this.isAsleepCondition(phoneData, pcData)) {
      return `【${name}】\n  ${name}好像睡着了呢\n`
    }
    let msg = `【${name}】\n` + this.formatPersonBlock(name, phoneData, pcData, { hidePc: HIDE_PC_NAMES.includes(name) })
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
        const musicPimeng = this.parseMusicWindowTitle(wt)
        if (musicPimeng) {
          const { app: appName, song: songName } = musicPimeng
          phonePrefix = '🎵皮梦正在听音乐：'
          phoneContent = `▶曲目：${songName}\n▶用${appName}听的`
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
          `更新时间：${fmtTime(phoneData)}`,
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
      const musicPc = this.parseMusicWindowTitle(fullWindowTitle)
      let pcContent
      if (musicPc) {
        pcContent = `🎵正在听：${musicPc.song}\n▶应用：${musicPc.app}`
      } else {
        const browserPc = this.parseBrowserStyleTitle(fullWindowTitle)
        if (browserPc) {
          pcContent = `▶应用：${browserPc.appName}\n▶窗口标题：${browserPc.windowTitle}`
        } else {
          const first = fullWindowTitle.split(' - ')[0] || '未知'
          pcContent = `▶应用：${first}\n▶窗口标题：${fullWindowTitle}`
        }
      }
      pcBlock = [
        '====== 电脑状态 ======',
        '💻皮梦的电脑正在运行：',
        pcContent,
        `更新时间：${fmtTime(pcData)}`,
        '来自：皮梦 の PC'
      ].join('\n')
    }
    return phoneBlock + '\n' + pcBlock
  }

  /** 指令主体与名单映射：所有人 不在此处返回，由 query 内从服务端 /api/names 拉取 */
  getNamesBySubject(subject) {
    const c = this.spyStatusCfg || loadSpyStatusConfig()
    if (this.isTeamSubject(subject)) {
      const names = Array.isArray(c.teamNames) ? c.teamNames : []
      return names.length > 0 ? names : null
    }
    const persons = Array.isArray(c.persons) ? c.persons : []
    const p = persons.find((x) => x && (x.name === subject || x.trigger === subject))
    return p && p.name ? [p.name] : null
  }

  /** 判断指令主体是否为团队查询 */
  isTeamSubject(subject) {
    const c = this.spyStatusCfg || loadSpyStatusConfig()
    const teamTrigger = c.teamTrigger || '时间开发团队'
    const aliases = [teamTrigger, teamTrigger.replace(/^时间/, '')].filter(Boolean)
    return aliases.includes(subject)
  }

  /** 某人是否使用独立 API 源（从 config 的 persons[].apiBase 读取） */
  getApiBaseForName(name) {
    const c = this.spyStatusCfg || loadSpyStatusConfig()
    const persons = Array.isArray(c.persons) ? c.persons : []
    const p = persons.find((x) => x && x.name === name)
    if (p && p.apiBase) return String(p.apiBase).replace(/\/$/, '')
    if (name === '雨核' || name === '皮梦') return CONFIG.STATUS_API_BASE
    return CONFIG.API_BASE
  }

  /** 看看xx今天做了什么：整合当天上传数据，按心跳计算设备/应用使用时长 */
  async queryToday() {
    this.spyStatusCfg = loadSpyStatusConfig()
    const c = this.spyStatusCfg
    const raw = (this.e.msg || '').trim()
    const match = raw.match(/^看看(.+?)今天做了什么\s*$/)
    if (!match) return
    const name = match[1].trim()
    const heartbeatSec = Number(c.heartbeatIntervalSeconds) > 0 ? Number(c.heartbeatIntervalSeconds) : CONFIG.HEARTBEAT_INTERVAL_SECONDS
    // 统计口径：按北京时间今天 00:00 到当前时刻（截止目前）
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
    const nowMs = Date.now()
    const bj = new Date(nowMs + BEIJING_OFFSET_MS)
    const y = bj.getUTCFullYear()
    const m = bj.getUTCMonth()
    const d = bj.getUTCDate()
    const startMs = Date.UTC(y, m, d, 0, 0, 0, 0) - BEIJING_OFFSET_MS
    const endMs = startMs + 24 * 60 * 60 * 1000
    const elapsedSeconds = Math.max(1, Math.floor((nowMs - startMs) / 1000))

    let list
    try {
      const apiBase = this.getApiBaseForName(name)
      list = await this.fetchTodayEvents(name, apiBase)
    } catch (e) {
      logger.warn('[spy-status] 今日事件拉取失败:', name, e && e.message)
      await this.e.reply(`获取${name}的今日数据失败（请确认服务端已实现 /api/today-events 且可访问）：${e && e.message}`)
      return
    }

    // 服务端已按北京时间过滤过“今日”，这里再按北京时间的 UTC 范围兜底过滤，避免时区不一致导致漏/错
    const todayEvents = (list || []).filter((ev) => {
      if (!ev || !ev.access_time) return false
      const t = new Date(ev.access_time).getTime()
      return !isNaN(t) && t >= startMs && t < endMs
    })
    if (todayEvents.length === 0) {
      await this.e.reply(`${name}今天还没有上传过数据呢，视奸不到哦`)
      return
    }

    const phoneEvents = todayEvents.filter((e) => this.isPhoneDevice(e.machine))
    const pcEvents = HIDE_PC_NAMES.includes(name) ? [] : todayEvents.filter((e) => !this.isPhoneDevice(e.machine))
    // 当日使用情况去除熄屏类、噪音应用（不展示且不计入时长/占比）
    const phoneEventsFiltered = phoneEvents.filter((e) => !this.isNoiseOrScreenOffForStats(e, true))
    const pcEventsFiltered = pcEvents.filter((e) => !this.isNoiseOrScreenOffForStats(e, false))

    const buildDeviceBlock = (deviceEvents, deviceLabel) => {
      if (!deviceEvents.length) return { lines: [], coveredSeconds: 0, percentOfDay: 0 }
      const totalHeartbeats = deviceEvents.length
      const coveredSeconds = totalHeartbeats * heartbeatSec
      const byApp = Object.create(null)
      for (const ev of deviceEvents) {
        const appName = this.getAppNameForStats(ev, deviceLabel === '手机')
        byApp[appName] = (byApp[appName] || 0) + 1
      }
      const sorted = Object.entries(byApp)
        .map(([app, count]) => ({ app, count, seconds: count * heartbeatSec }))
        .sort((a, b) => b.seconds - a.seconds)
      const lines = [`▶${deviceLabel}`]
      sorted.forEach((item, i) => {
        const pct = coveredSeconds > 0 ? ((item.seconds / coveredSeconds) * 100).toFixed(1) : '0'
        lines.push(`${i + 1}.${item.app} 用了${this.formatDuration(item.seconds)} 占比${pct}%`)
      })
      return { lines, coveredSeconds, percentToNow: Math.min(100, (coveredSeconds / elapsedSeconds) * 100) }
    }

    const phoneBlock = buildDeviceBlock(phoneEventsFiltered, '手机')
    const pcBlock = buildDeviceBlock(pcEventsFiltered, '电脑')
    const totalCovered = (phoneBlock.coveredSeconds || 0) + (pcBlock.coveredSeconds || 0)
    const totalPercent = Math.min(100, (totalCovered / elapsedSeconds) * 100)

    // 三条消息合并转发，直接发送不回复用户
    const firstMsg = `${name}今天截止目前有${totalPercent.toFixed(1)}%的时间都被我视奸到了呢 这是他的设备今天的使用情况`
    const secondMsg = (phoneBlock.lines || []).join('\n') || '▶手机\n  暂无数据'
    const thirdMsg = (pcBlock.lines || []).join('\n') || '▶电脑\n  暂无数据'
    const forwardBlocks = [firstMsg, secondMsg, thirdMsg]
    const forwardMsg = await common.makeForwardMsg(this.e, forwardBlocks, `${name}今日使用情况`)
    if (this.e.group_id) {
      await this.e.group.sendMsg(forwardMsg)
    } else {
      const target = this.e.bot.pickUser(this.e.user_id)
      if (target) await target.sendMsg(forwardMsg)
    }
  }

  async query() {
    this.spyStatusCfg = loadSpyStatusConfig()
    const c = this.spyStatusCfg
    const raw = (this.e.msg || '').trim()
    const match = raw.match(/^(.+?)在干嘛\s*$/)
    if (!match) return

    const subject = match[1].trim()
    let names
    let isAllQuery = false
    if (subject === '所有人' || subject === '时间所有人') {
      isAllQuery = true
      try {
        names = await this.fetchNames()
      } catch (e) {
        logger.error('[spy-status] 所有人：获取名单失败', e && e.message)
        await this.e.reply('获取所有人名单失败，请确认服务端已启动且 ' + CONFIG.API_BASE + ' 可访问。')
        return
      }
      if (!names || names.length === 0) {
        await this.e.reply('服务端当前没有任何已配置的用户（group-map 为空）。')
        return
      }
    } else {
      names = this.getNamesBySubject(subject)
    }
    if (!names || !Array.isArray(names) || names.length === 0) {
      logger.warn('[spy-status] 未知指令:', subject)
      return
    }

    const isTeamQuery = this.isTeamSubject(subject) || isAllQuery
    const now = Date.now()
    const cacheKey = names.slice().sort().join(',')
    const cached = cache.byNames[cacheKey]
    if (cached && (now - cache.timestamp) < CONFIG.CACHE_EXPIRE_TIME) {
      if (Array.isArray(cached)) {
        const title = isAllQuery ? '所有人状态' : (c.teamForwardTitle || '开发团队状态')
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

    const isForward = isTeamQuery && blocks.length > 0
    if (isForward) {
      const isDevTeam = this.isTeamSubject(subject)
      const forwardBlocks = isDevTeam ? ['这是当前knd dev team成员状态', ...blocks] : blocks
      cache.byNames[cacheKey] = forwardBlocks
      cache.timestamp = now
      const title = isAllQuery ? '所有人状态' : (c.teamForwardTitle || '开发团队状态')
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

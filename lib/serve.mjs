// dsh-libtv 的 stdio 桥。
//
// 宿主（@deepseek-ai/dsh-mcp-client）用 newline-delimited JSON-RPC 说话；远端 LibTV 网关
// 是 streamable HTTP（可能是 JSON，也可能是 SSE）。这一层做四件远端不负责的事：
//
//   1. 携带 OAuth bearer token（宿主只能配静态 headers，没有授权码流程）。
//   2. 首次使用时把浏览器打开到微信扫码页，用户零终端完成授权。
//   3. 未授权时仍能完成握手：本地应答 initialize / tools/list，只暴露 libtv_auth，
//      这样模型有入口把用户带去扫一次码；授权成功后通知宿主刷新工具清单。
//   4. 可选的 tools/list 白名单裁剪（默认关闭）。
//
// 注意：dsh-mcp-client 在正式进程之前会先起一个「探针进程」做协商。所以开浏览器这类
// 有副作用的动作绝不能挂在 initialize / tools/list 上，只挂在 tools/call 与本地工具上。

import readline from 'node:readline'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  MCP_URL,
  AuthRequired,
  authSummary,
  clearCreds,
  getAccessToken,
  login,
} from './oauth.mjs'

const CLIENT_INFO = { name: 'dsh-libtv', version: '0.1.0' }
const PROTOCOL_VERSION = '2025-06-18'

let sessionId = null
let remoteReady = false

// ── 授权状态 ────────────────────────────────────────────────────────────────

let authFlow = null
let lastAuthUrl = null

function startAuth() {
  if (authFlow) return authFlow
  authFlow = login({ onAuthorizeUrl: (url) => { lastAuthUrl = url } })
    .then(async () => {
      console.error('dsh-libtv: 授权完成，正在通知宿主刷新工具清单')
      await primeRemoteSession()
      notifyToolsChanged()
    })
    .catch((err) => {
      console.error(`dsh-libtv: 授权失败：${err?.message || err}`)
    })
    .finally(() => {
      authFlow = null
    })
  return authFlow
}

function authState() {
  const summary = authSummary()
  return {
    status: summary.authorized ? 'authorized' : 'unauthorized',
    inProgress: Boolean(authFlow),
    authorizeUrl: lastAuthUrl,
    credentialsPath: summary.credentialsPath,
    scope: summary.scope,
    expiresAt: summary.expiresAt,
    hasRefreshToken: summary.hasRefreshToken,
  }
}

const AUTH_TOOL = {
  name: 'libtv_auth',
  description:
    'LibTV 授权入口。LibTV 的所有工具都需要一次微信扫码授权。' +
    'action=start：在本机浏览器打开 LibTV 授权页，用户用微信扫码确认即可（授权一次后长期有效，靠 refresh token 自动续期）。' +
    'action=status：查看当前是否已授权（默认）。action=logout：清除本机凭据。' +
    '只有当 LibTV 工具报「尚未授权」时才需要调用本工具。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'start', 'logout'],
        description: '默认 status。start 会打开浏览器完成扫码授权。',
      },
    },
    additionalProperties: false,
  },
}

const AUTH_HINT =
  '【LibTV 授权 / libtv_auth】本机还没有 LibTV 凭据，所以现在只能看到一个工具 libtv_auth。' +
  '调用 libtv_auth（action=start）即可在本机浏览器打开微信扫码授权页；用户扫码确认后工具清单会自动刷新，' +
  '再按用户要求继续原来的任务。授权只做一次，之后由 refresh token 自动续期。'

function authText(payload) {
  const lines = [`LibTV 授权状态：${payload.status}`]
  if (payload.status === 'authorized') {
    if (payload.expiresAt) lines.push(`access token 到期：${payload.expiresAt}`)
    if (payload.hasRefreshToken) lines.push('已保存 refresh token，会自动续期。')
  } else if (payload.authorizeUrl) {
    lines.push('请在浏览器里用微信扫码并确认：')
    lines.push(payload.authorizeUrl)
    if (payload.inProgress) lines.push('（等待扫码中；确认后直接重试 LibTV 工具即可）')
  } else if (payload.inProgress) {
    lines.push('正在申请授权页，稍等片刻再查一次 action=status。')
  } else {
    lines.push('调用 libtv_auth（action=start）打开授权页。')
  }
  lines.push(`凭据位置：${payload.credentialsPath}`)
  return lines.join('\n')
}

// ── 工具白名单（默认关闭）────────────────────────────────────────────────────
//
// 远端有 86 个工具，schema 会全部常驻提示词。宿主没有工具筛选配置项，所以留一个
// 本地开关：LIBTV_TOOL_FILTER（逗号/空格分隔）优先，否则读 <LIBTV_HOME>/tools.allow。
// 不配就是不裁剪。

function loadToolFilter() {
  const home = process.env.LIBTV_HOME || join(homedir(), '.libtv')
  let raw = (process.env.LIBTV_TOOL_FILTER || '').trim()
  if (!raw) {
    const path = join(home, 'tools.allow')
    try {
      if (existsSync(path)) raw = readFileSync(path, 'utf8')
    } catch {
      /* 读不到就当没配 */
    }
  }
  if (!raw) return null
  const names = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .flatMap((line) => line.split(/[\s,]+/))
    .map((name) => name.trim())
    .filter(Boolean)
  return names.length ? new Set(names) : null
}

const allowTools = loadToolFilter()

// ── JSON-RPC 收尾 ──────────────────────────────────────────────────────────

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function notifyToolsChanged() {
  writeLine({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
}

function rpcError(id, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: -32000, message } }
}

function hintFor(err) {
  if (err instanceof AuthRequired) return err.message
  return String(err?.message || err)
}

// 只动两类响应：initialize 的 instructions（告诉模型怎么授权）、tools/list（注入本地工具并裁剪）。
function emitMessage(message) {
  const result = message?.result

  if (result && Array.isArray(result.tools)) {
    if (!result.tools.some((tool) => tool?.name === AUTH_TOOL.name)) {
      result.tools.unshift(AUTH_TOOL)
    }
    if (allowTools) {
      const before = result.tools.length
      result.tools = result.tools.filter(
        (tool) => tool?.name === AUTH_TOOL.name || allowTools.has(tool?.name),
      )
      if (result.tools.length !== before) {
        console.error(`dsh-libtv: 工具清单按白名单裁剪 ${before} → ${result.tools.length}`)
      }
    }
  }

  // initialize 结果带 protocolVersion；只在未授权时补一句，不碰 tools/list。
  if (result && typeof result.protocolVersion === 'string' && !authSummary().authorized) {
    result.instructions = result.instructions
      ? `${result.instructions}\n\n${AUTH_HINT}`
      : AUTH_HINT
  }

  writeLine(message)
}

// ── 本地工具 ───────────────────────────────────────────────────────────────

function handleLocalTool(message) {
  const action = message.params?.arguments?.action || 'status'

  if (action === 'start' && authState().status !== 'authorized') {
    startAuth()
  } else if (action === 'logout') {
    clearCreds()
    lastAuthUrl = null
    remoteReady = false
  }

  const payload = authState()
  writeLine({
    jsonrpc: '2.0',
    id: message.id === undefined ? null : message.id,
    result: {
      content: [{ type: 'text', text: authText(payload) }],
      structuredContent: payload,
      isError: false,
    },
  })
}

// ── 远端转发 ───────────────────────────────────────────────────────────────

async function post(token, payload) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  const nextSession = res.headers.get('mcp-session-id')
  if (nextSession && nextSession !== sessionId) sessionId = nextSession
  return res
}

async function emitSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        emitMessage(JSON.parse(payload))
      } catch {
        process.stdout.write(`${payload}\n`)
      }
    }
  }
}

// 授权成功后才建立远端会话：宿主那侧的 initialize 是在未授权时由本地应答的，
// 远端会话必须由我们自己补一次，否则随后的 tools/list 会被服务端拒绝。
async function primeRemoteSession() {
  if (remoteReady) return
  try {
    const token = await getAccessToken()
    const res = await post(token, {
      jsonrpc: '2.0',
      id: 'dsh-libtv-prime',
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    })
    await res.text().catch(() => '')
    if (res.ok) {
      await post(token, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
      remoteReady = true
    }
  } catch (err) {
    console.error(`dsh-libtv: 建立远端会话失败：${err?.message || err}`)
  }
}

// 未授权时不要只抛一句 401：顺手把浏览器打开，并把可点/可复制的地址交给模型。
function reportAuthBlocked(message) {
  startAuth()
  const text =
    'LibTV 尚未授权（或授权已过期）。' +
    (lastAuthUrl
      ? `\n已在浏览器打开授权页，请用微信扫码并确认：\n${lastAuthUrl}`
      : '\n正在向授权服务器申请授权页，稍等一秒后调用 libtv_auth（action=status）取地址。')
    + '\n完成扫码后重试刚才的调用即可。'
  if (message.id === undefined) {
    console.error(text)
    return
  }
  writeLine(rpcError(message.id, text))
}

// 未授权时由本地应答，保证握手能完成、模型有 libtv_auth 这个入口。
function handleUnauthorized(message) {
  const method = message.method
  if (typeof method === 'string' && method.startsWith('notifications/')) return

  if (method === 'initialize') {
    writeLine({
      jsonrpc: '2.0',
      id: message.id === undefined ? null : message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'libtv', version: 'unauthorized' },
        instructions: AUTH_HINT,
      },
    })
    return
  }

  if (method === 'tools/list') {
    emitMessage({
      jsonrpc: '2.0',
      id: message.id === undefined ? null : message.id,
      result: { tools: [AUTH_TOOL] },
    })
    return
  }

  reportAuthBlocked(message)
}

async function forward(message) {
  let token
  try {
    token = await getAccessToken()
  } catch (err) {
    if (err instanceof AuthRequired) {
      handleUnauthorized(message)
      return
    }
    if (message.id !== undefined) writeLine(rpcError(message.id, hintFor(err)))
    else console.error(`dsh-libtv: ${hintFor(err)}`)
    return
  }

  let res = await post(token, message)
  if (res.status === 401) {
    // token 被提前吊销：刷新一次再试。
    try {
      token = await getAccessToken({ force: true })
    } catch (err) {
      if (err instanceof AuthRequired) handleUnauthorized(message)
      else if (message.id !== undefined) writeLine(rpcError(message.id, hintFor(err)))
      return
    }
    res = await post(token, message)
  }

  if (res.status === 202 || res.status === 204) return

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 500)
    const detail = `LibTV MCP 返回 HTTP ${res.status}：${text || '(空响应)'}`
    if (message.id !== undefined) writeLine(rpcError(message.id, detail))
    else console.error(`dsh-libtv: ${detail}`)
    return
  }

  if (message.method === 'initialize') remoteReady = true

  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('text/event-stream')) {
    await emitSse(res.body)
    return
  }

  const text = await res.text()
  const trimmed = text.trim()
  if (!trimmed) return
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    process.stdout.write(`${trimmed}\n`)
    return
  }
  if (Array.isArray(parsed)) parsed.forEach(emitMessage)
  else emitMessage(parsed)
}

export function serve() {
  const summary = authSummary()
  if (!summary.authorized) {
    console.error(
      'dsh-libtv: 尚未完成 LibTV 授权。会话里调用 libtv_auth（action=start）即可扫码授权。\n' +
        `  凭据位置： ${summary.credentialsPath}`,
    )
  }
  if (allowTools) {
    console.error(`dsh-libtv: 工具白名单已启用，${allowTools.size} 个远端工具放行`)
  }

  // 握手阶段必须串行：initialize → notifications/initialized → tools/list。
  // 否则三个 POST 并发飞出，服务端可能先收到 tools/list 而拒绝。
  // 握手完成后放开并发，长任务（出图/渲染）不会把别的调用堵在队列后面。
  let queue = Promise.resolve()
  let ready = false

  function fail(message, err) {
    if (message && message.id !== undefined) writeLine(rpcError(message.id, hintFor(err)))
    else console.error(`dsh-libtv: ${hintFor(err)}`)
  }

  function enqueue(message) {
    // 本地工具不进远端队列，也不受握手串行限制。
    if (message.method === 'tools/call' && message.params?.name === AUTH_TOOL.name) {
      handleLocalTool(message)
      return
    }
    if (ready) {
      forward(message).catch((err) => fail(message, err))
      return
    }
    queue = queue.then(async () => {
      try {
        await forward(message)
      } catch (err) {
        fail(message, err)
      }
      if (message.method === 'initialize') ready = true
    })
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      console.error('dsh-libtv: 收到无法解析的行，已忽略')
      return
    }
    enqueue(message)
  })

  process.stdin.on('end', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
}

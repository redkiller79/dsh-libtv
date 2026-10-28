// LibTV 远程 MCP 的授权层。
//
// 网关 (https://mcp.liblib.tv/mcp) 只认 OAuth 2.1 授权码 + PKCE 的 bearer token，
// 元数据见 /.well-known/oauth-authorization-server：authorize / token / register(动态注册) / revoke，
// scopes: libtv:account:read, libtv:project:read|write, libtv:media:write, libtv:task:write, libtv:export:write
//
// 凭据落在 ~/.libtv/credentials.json（可用 LIBTV_HOME 覆盖），权限 0600。
// 刻意不读任何环境变量里的 token：dsh-mcp-client 会按 /KEY|PASSWORD|SECRET|TOKEN/i 清洗子进程环境。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export const ISSUER = process.env.LIBTV_ISSUER || 'https://mcp.liblib.tv'
export const MCP_URL = process.env.LIBTV_MCP_URL || 'https://mcp.liblib.tv/mcp'

export const SCOPES = [
  'libtv:account:read',
  'libtv:project:read',
  'libtv:project:write',
  'libtv:media:write',
  'libtv:task:write',
  'libtv:export:write',
]

const HOME = process.env.LIBTV_HOME || path.join(os.homedir(), '.libtv')
const CRED_FILE = path.join(HOME, 'credentials.json')
const PORT = Number(process.env.LIBTV_OAUTH_PORT || 8765)
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`
const CLIENT_NAME = 'DeepSeek Harness libtv MCP proxy'
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

export class AuthRequired extends Error {
  constructor(message) {
    super(message || 'LibTV 尚未授权（需要一次微信扫码授权）')
    this.name = 'AuthRequired'
    this.code = 'AUTH_REQUIRED'
  }
}

export function credentialsPath() {
  return CRED_FILE
}

export function loadCreds() {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function saveCreds(creds) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })
  fs.writeFileSync(CRED_FILE, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(CRED_FILE, 0o600)
  } catch {
    // Windows 上没有 POSIX 权限位，忽略。
  }
}

export function clearCreds() {
  try {
    fs.unlinkSync(CRED_FILE)
  } catch {
    // 本来就没有，无所谓。
  }
}

let metaCache

export async function discover() {
  if (metaCache) return metaCache
  const res = await fetch(`${ISSUER}/.well-known/oauth-authorization-server`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`读取授权服务器元数据失败：HTTP ${res.status}`)
  metaCache = await res.json()
  return metaCache
}

let resourceCache

/**
 * RFC 9728 保护资源元数据。LibTV 的授权服务器强制要求 authorize（以及 token）
 * 请求里带 resource=https://mcp.liblib.tv/mcp，缺了直接 invalid_request。
 */
export async function discoverResource() {
  if (resourceCache) return resourceCache
  try {
    const res = await fetch(`${ISSUER}/.well-known/oauth-protected-resource`, {
      headers: { accept: 'application/json' },
    })
    if (res.ok) {
      resourceCache = await res.json()
      return resourceCache
    }
  } catch {
    // 拿不到就退回网关地址本身。
  }
  resourceCache = { resource: MCP_URL }
  return resourceCache
}

async function registerClient(meta) {
  if (!meta.registration_endpoint) {
    throw new Error('授权服务器未提供动态注册端点，无法自动注册客户端')
  }
  const res = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPES.join(' '),
    }),
  })
  if (!res.ok) {
    throw new Error(`动态注册客户端失败：HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`)
  }
  const body = await res.json()
  const creds = loadCreds()
  creds.client_id = body.client_id
  creds.client_secret = body.client_secret
  creds.redirect_uri = REDIRECT_URI
  creds.issuer = meta.issuer
  creds.service = MCP_URL
  saveCreds(creds)
  return creds
}

export async function ensureClient() {
  const meta = await discover()
  const creds = loadCreds()
  if (creds.client_id && creds.redirect_uri === REDIRECT_URI && creds.issuer === meta.issuer) {
    return creds
  }
  return registerClient(meta)
}

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

function makePkce() {
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function openBrowser(url) {
  const target =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    spawn(target[0], target[1], { stdio: 'ignore', detached: true }).unref()
  } catch {
    // 打不开就算了，下面会把链接打出来，手动打开即可。
  }
}

function storeTokens(creds, token) {
  const expiresIn = Number(token.expires_in)
  creds.tokens = {
    access_token: token.access_token,
    refresh_token: token.refresh_token || creds.tokens?.refresh_token,
    token_type: token.token_type || 'Bearer',
    scope: token.scope,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    obtained_at: new Date().toISOString(),
  }
  saveCreds(creds)
  return creds.tokens
}

async function waitForCallback(state) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
        return
      }
      const error = url.searchParams.get('error')
      const ok = !error
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><meta charset="utf-8"><title>LibTV 授权</title>` +
          `<body style="font:16px/1.7 system-ui,sans-serif;padding:48px;color:#111">` +
          `<h2 style="color:${ok ? '#07B8DD' : '#c33'}">${ok ? '授权完成' : '授权失败'}</h2>` +
          `<p>${ok ? '可以关闭此页面，回到终端继续。' : `错误：${escapeHtml(error)} ${escapeHtml(url.searchParams.get('error_description') || '')}`}</p>` +
          `</body>`,
      )
      cleanup()
      if (error) {
        reject(new Error(`LibTV 授权被拒绝：${error} ${url.searchParams.get('error_description') || ''}`))
        return
      }
      if (url.searchParams.get('state') !== state) {
        reject(new Error('OAuth state 校验失败，可能是被伪造的回调'))
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        reject(new Error('回调里没有 code 参数'))
        return
      }
      resolve(code)
    })

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('授权超时（10 分钟未完成）'))
    }, LOGIN_TIMEOUT_MS)
    timer.unref?.()

    function cleanup() {
      clearTimeout(timer)
      server.close()
    }

    server.on('error', (err) => {
      cleanup()
      reject(new Error(`无法监听 127.0.0.1:${PORT}：${err.message}。可用 LIBTV_OAUTH_PORT 换一个端口。`))
    })
    server.listen(PORT, '127.0.0.1')
  })
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export async function login({ onAuthorizeUrl } = {}) {
  const meta = await discover()
  const creds = await ensureClient()
  const { resource } = await discoverResource()
  const { verifier, challenge } = makePkce()
  const state = b64url(crypto.randomBytes(16))

  const authorizeUrl = new URL(meta.authorization_endpoint)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', creds.client_id)
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authorizeUrl.searchParams.set('scope', SCOPES.join(' '))
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  // Resource Indicators (RFC 8707)——LibTV 网关强制校验，缺了会 invalid_request。
  authorizeUrl.searchParams.set('resource', resource || MCP_URL)

  const waiting = waitForCallback(state)
  // 给 listen 一点时间再开浏览器，避免回调先到、端口还没起。
  await new Promise((r) => setTimeout(r, 150))
  const target = authorizeUrl.toString()
  console.error(`\n正在打开浏览器完成 LibTV 授权。\n若没有自动打开，请手动访问：\n\n${target}\n`)
  onAuthorizeUrl?.(target)
  // 无头/服务器环境可设 LIBTV_OPEN_BROWSER=0，只打印链接不开浏览器。
  if (process.env.LIBTV_OPEN_BROWSER !== '0') openBrowser(target)

  const code = await waiting

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: creds.client_id,
    code_verifier: verifier,
    resource: resource || MCP_URL,
  })
  if (creds.client_secret) form.set('client_secret', creds.client_secret)

  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
  })
  if (!res.ok) {
    throw new Error(`换取 token 失败：HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`)
  }
  return storeTokens(loadCreds(), await res.json())
}

let refreshing = null

async function refresh(creds) {
  const meta = await discover()
  const refreshToken = creds.tokens?.refresh_token
  if (!refreshToken) throw new AuthRequired()

  const { resource } = await discoverResource()
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: creds.client_id,
    resource: resource || MCP_URL,
  })
  if (creds.client_secret) form.set('client_secret', creds.client_secret)

  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    clearCreds()
    throw new AuthRequired(
      `LibTV 授权已失效（refresh HTTP ${res.status} ${body.slice(0, 200)}）。请重新运行： npx libtv-mcp-proxy login`,
    )
  }
  return storeTokens(creds, await res.json())
}

/**
 * 拿一个可用的 access token；快过期就先用 refresh_token 换掉。
 * force=true 用于服务端回了 401（token 被提前吊销）的场景。
 */
export async function getAccessToken({ force = false } = {}) {
  const creds = loadCreds()
  if (!creds.tokens?.access_token) throw new AuthRequired()

  const expiresAt = creds.tokens.expires_at
  const stillFresh = typeof expiresAt !== 'number' || expiresAt - 60_000 > Date.now()
  if (!force && stillFresh) return creds.tokens.access_token

  if (!refreshing) {
    refreshing = refresh(loadCreds()).finally(() => {
      refreshing = null
    })
  }
  const tokens = await refreshing
  return tokens.access_token
}

export function authSummary() {
  const creds = loadCreds()
  return {
    service: MCP_URL,
    credentialsPath: CRED_FILE,
    clientId: creds.client_id || null,
    authorized: Boolean(creds.tokens?.access_token),
    scope: creds.tokens?.scope || null,
    expiresAt: creds.tokens?.expires_at ? new Date(creds.tokens.expires_at).toISOString() : null,
    hasRefreshToken: Boolean(creds.tokens?.refresh_token),
  }
}

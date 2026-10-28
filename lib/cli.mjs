#!/usr/bin/env node
// 无头环境/排障用的命令行入口。桌面会话里不需要它——授权由 libtv_auth 工具在会话内完成。
//
//   npx dsh-libtv login    打开浏览器完成一次授权
//   npx dsh-libtv status   打印当前凭据状态
//   npx dsh-libtv logout   清除本机凭据

import { authSummary, clearCreds, login } from './oauth.mjs'

const action = process.argv[2] || 'status'

if (action === 'login') {
  await login()
  console.log('授权完成。')
  console.log(JSON.stringify(authSummary(), null, 2))
} else if (action === 'logout') {
  clearCreds()
  console.log('已清除本机 LibTV 凭据。')
} else if (action === 'status') {
  console.log(JSON.stringify(authSummary(), null, 2))
} else {
  console.error(`未知子命令：${action}\n用法：libtv-auth [login|status|logout]`)
  process.exit(1)
}

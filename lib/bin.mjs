#!/usr/bin/env node
/**
 * 命令行诊断：不开 GUI 也能确认两个平台接上了没有。
 *
 *   dsh-huawei-connect status    账号、积分、模型数
 *   dsh-huawei-connect models    上游真实模型清单
 *   dsh-huawei-connect sync      从上游同步登录态
 *
 * 输出里**不含任何密钥**，可以直接贴进问题反馈。
 */
import { AccountStore, listOfficeAceCredentialTargets, readCodeArtsAccounts, readOfficeAceAccount } from '../lib/store.mjs'
import { startLogin, remainingMs } from '../lib/oauth.mjs'
import { accountsPath } from '../lib/paths.mjs'
import { fetchCodeArtsCredits, fetchCodeArtsModels } from '../lib/codearts.mjs'
import { fetchOfficeAceModels, fetchLocalControl, parseOfficeAcePackageUsage, parseOfficeAceSubscription } from '../lib/officeace.mjs'
import { readOfficeAceSession } from '../lib/session.mjs'

const command = process.argv[2] ?? 'status'

function line(label, value) {
  console.log('  ' + label.padEnd(14) + value)
}

async function status() {
  const store = new AccountStore(accountsPath())
  await store.load()
  const accounts = store.snapshot()
  if (accounts.length === 0) {
    console.log('没有同步到账号。先运行 sync。')
    return
  }
  for (const account of accounts) {
    console.log('\n[' + account.platform + '] ' + (account.userName || account.id))
    line('账号 id', account.id)
    line('上次同步', account.syncedAt === 0 ? '—' : new Date(account.syncedAt).toISOString())
    if (account.syncError) line('同步错误', account.syncError)
    if (account.platform === 'codearts') {
      try {
        const credits = await fetchCodeArtsCredits(account.codeArts, AbortSignal.timeout(20000))
        line('套餐', credits.planName ?? '—')
        line('积分', '剩 ' + credits.total.remain + ' / 共 ' + credits.total.total + '（已用 ' + credits.total.used + '）')
        if (credits.periodEnd) line('周期至', credits.periodEnd)
      } catch (error) {
        line('积分', '不可用：' + String(error).slice(0, 120))
      }
    } else {
      try {
        const session = await readOfficeAceSession()
        if (session === undefined) {
          line('积分', '读不到会话，请先打开果办')
        } else {
          const subscription = parseOfficeAceSubscription(
            await fetchLocalControl(session.value, '/api/subscription/current', AbortSignal.timeout(20000)),
          )
          if (subscription) {
            line('套餐', subscription.planName ?? '—')
            line('积分', '剩 ' + subscription.remain + ' / 共 ' + subscription.total)
            if (subscription.expiresAt) line('到期', subscription.expiresAt)
          }
          const usage = parseOfficeAcePackageUsage(
            await fetchLocalControl(session.value, '/api/codeagent-package/usage', AbortSignal.timeout(20000)),
          )
          if (usage) line('码道兼容包', '剩 ' + usage.remain + ' / 共 ' + usage.total)
        }
      } catch (error) {
        line('积分', '不可用：' + String(error).slice(0, 120))
      }
    }
  }
}

async function models() {
  const store = new AccountStore(accountsPath())
  await store.load()
  for (const account of store.list('codearts')) {
    try {
      const list = await fetchCodeArtsModels(account.codeArts, AbortSignal.timeout(20000))
      console.log('\n[codearts] ' + list.length + ' 个模型：' + list.map((m) => m.id).join(', '))
    } catch (error) {
      console.log('\n[codearts] 失败：' + String(error).slice(0, 160))
    }
  }
  for (const account of store.list('officeace')) {
    try {
      const list = await fetchOfficeAceModels(account.officeAce.gateway, AbortSignal.timeout(20000))
      console.log('\n[officeace] ' + list.length + ' 个模型：' + list.map((m) => m.id).join(', '))
    } catch (error) {
      console.log('\n[officeace] 失败：' + String(error).slice(0, 160))
    }
  }
}

async function sync() {
  const store = new AccountStore(accountsPath())
  await store.load()
  const codeArts = await readCodeArtsAccounts()
  for (const entry of codeArts) {
    await store.upsert({
      platform: 'codearts',
      id: entry.id,
      userName: entry.userName,
      userId: entry.id,
      syncedAt: Date.now(),
      syncError: '',
      codeArts: entry.credential,
    })
  }
  console.log('码道：' + codeArts.length + ' 个账号')

  const targets = await listOfficeAceCredentialTargets()
  let count = 0
  for (const target of targets) {
    const account = await readOfficeAceAccount(target)
    if (account === undefined) continue
    count += 1
    await store.upsert({
      platform: 'officeace',
      id: account.id,
      userName: account.userName,
      userId: account.id,
      syncedAt: Date.now(),
      syncError: '',
      officeAce: { gateway: account.gateway },
    })
  }
  console.log('果办：' + count + ' 个账号')
}

/** 浏览器登录：打印授权地址，等回调。 */
async function login() {
  const platform = process.argv[3]
  if (platform !== 'codearts' && platform !== 'officeace') {
    console.log('用法: dsh-huawei-connect login <codearts|officeace>')
    process.exitCode = 1
    return
  }
  const session = startLogin(platform)
  const url = await session.authorizeUrl
  console.log('在浏览器中打开下面的地址完成登录：\n')
  console.log(url)
  console.log('\n等待授权回调…（Ctrl+C 取消）')
  try {
    const credential = await session.promise
    const store = new AccountStore(accountsPath())
    await store.load()
    const id = credential.userId || credential.domainId
    if (!id) throw new Error('登录成功但上游没给稳定身份')
    await store.upsert({
      platform,
      id,
      userName: credential.userName || id,
      userId: id,
      syncedAt: Date.now(),
      syncError: '',
      origin: 'login',
      oauth: credential,
      ...(platform === 'codearts'
        ? {
            codeArts: {
              accessKeyId: credential.accessKeyId,
              secretAccessKey: credential.secretAccessKey,
              securityToken: credential.securityToken,
              userId: id,
              userName: credential.userName,
              expiresAt: credential.expiration || undefined,
            },
          }
        : {}),
    })
    console.log('\n登录成功：' + (credential.userName || id))
    console.log('  凭证剩余: ' + Math.round((remainingMs(credential) ?? 0) / 60000) + ' 分钟')
    console.log('  已写入: ' + accountsPath())
    if (platform === 'officeace') {
      console.log('\n注意：果办的模型网关地址来自云端订阅信息。若对话时报缺少网关，')
      console.log('      请打开果办一次让订阅信息生成，然后在卡片上点「同步登录态」。')
    }
  } catch (error) {
    console.log('\n登录失败: ' + String(error))
    process.exitCode = 1
  } finally {
    session.close()
  }
}

if (command === 'status') await status()
else if (command === 'models') await models()
else if (command === 'sync') await sync()
else if (command === 'login') await login()
else {
  console.log('用法: dsh-huawei-connect <status|models|sync|login <platform>>')
  process.exitCode = 1
}

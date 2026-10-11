import fs from 'fs'
import os from 'os'
import path from 'path'
import { exec, spawn } from 'child_process'
import { app, net } from 'electron'
import log from 'electron-log'
import type { IUpdateCheckResult, IUpdateInfo } from '@shared/types/ipc'
import { isWindows } from '../config'

/**
 * 应用自动更新（feat/updater）。
 *
 * 数据源是发布仓的 GitHub Release（`momark/<x.y.z>` tag），附件命名约定：
 *   - macOS arm64：`momark-mac-arm64-<ver>.zip`（dmg 不进自动安装链路）
 *   - Windows x64：`momark-win-x64-<ver>-setup.exe`（NSIS 自解压安装器）
 * 三步：查最新版 → 下载（带进度）→ 按平台解压/直接用 → 静默安装并重启。
 *
 * 为什么不用 electron-updater：macOS 上它的自动安装（Squirrel.Mac）**要求
 * 应用经过代码签名**，墨记当前未签名/未公证，走它只会在安装环节失败。
 * 自己实现 = 解压 + `cp -R` + `xattr -cr`（去掉下载隔离属性，免 Gatekeeper
 * 拦截），与本项目「用户手动 xattr -cr」的既有说明一致。
 */

const RELEASE_REPO = 'lixiaoshuang79/momark'
const LATEST_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`

/** 下载进度的回调载荷（进程内部用，跨进程的形状见 `IUpdateProgress`）。 */
export interface IDownloadProgress {
  received: number
  total: number
}

/** `momark/1.5.1` → `1.5.1`（也兼容裸 `v1.5.1` / `1.5.1` 的写法）。 */
const parseVersion = (tag: string): string =>
  tag
    .replace(/^momark\//, '')
    .replace(/^v/, '')
    .trim()

/** 语义化版本比较：a 比 b 新才返回 true（只比数字段，预发布后缀忽略）。 */
const isNewer = (a: string, b: string): boolean => {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)

  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0

    if (x !== y) return x > y
  }

  return false
}

/**
 * 在 release 资产列表里挑出当前平台能用的那一份。
 *
 * Windows 拿 NSIS 安装器（momark-win-x64-<ver>-setup.exe），macOS 拿 zip。
 * 命名约定见 electron-builder.yml 的 artifactName。返回 null = 没有可用
 * 附件（常见原因：另一个平台的 PR 还没发，或用上游 tag 但只打了一种资产）。
 */
const pickAsset = (
  assets: Array<{ name?: string; browser_download_url?: string; size?: number }>
): { name: string; url: string; size: number | null } | null => {
  for (const a of assets) {
    if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue
    if (isWindows) {
      // artifactName: momark-win-${arch}-${version}-setup.${ext}
      if (a.name.startsWith('momark-win-') && a.name.endsWith('-setup.exe')) {
        return {
          name: a.name,
          url: a.browser_download_url,
          size: typeof a.size === 'number' ? a.size : null
        }
      }
    } else {
      // artifactName: momark-mac-${arch}-${version}.${ext}（取 arm64：dmg 不能
      // 进程内解压，zip 才能自动安装）
      if (a.name.endsWith('.zip') && a.name.includes('arm64')) {
        return {
          name: a.name,
          url: a.browser_download_url,
          size: typeof a.size === 'number' ? a.size : null
        }
      }
    }
  }
  return null
}

/** 查 GitHub 上的最新 release 并和当前版本比对。任何失败都归到 `error`，不抛。 */
export const checkForUpdates = async (): Promise<IUpdateCheckResult> => {
  const current = app.getVersion()

  try {
    const res = await net.fetch(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MoMark-Updater' }
    })

    if (!res.ok) {
      log.warn(`[updater] check failed: HTTP ${res.status}`)

      return { hasUpdate: false, current, info: null, error: `HTTP ${res.status}` }
    }

    const data = (await res.json()) as {
      tag_name?: string
      body?: string
      published_at?: string
      assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>
    }

    const tagName = String(data.tag_name ?? '')
    const version = parseVersion(tagName)

    if (!version) {
      return { hasUpdate: false, current, info: null, error: 'release 缺少可识别的 tag' }
    }

    const asset = pickAsset(data.assets ?? [])
    const platformLabel = isWindows ? 'Windows' : 'macOS'

    const info: IUpdateInfo = {
      version,
      tagName,
      notes: String(data.body ?? ''),
      publishedAt: String(data.published_at ?? ''),
      assetUrl: asset?.url ?? null,
      assetName: asset?.name ?? null,
      assetSize: asset?.size ?? null
    }

    if (!asset) {
      return {
        hasUpdate: false,
        current,
        info: null,
        error: `release 缺少 ${platformLabel} 的可识别附件`
      }
    }

    return { hasUpdate: isNewer(version, current), current, info }
  } catch (error) {
    log.warn('[updater] check threw:', error)

    return { hasUpdate: false, current, info: null, error: String(error) }
  }
}

/**
 * 下载更新包到 `userData/updates/`，返回本地路径。
 *
 * 用 `net.fetch` 而不是 Node 的 https：它走 Electron 的网络栈（系统代理、
 * 证书策略与页面一致），大文件在弱网下也按块回调进度。
 *
 * 文件名直接来自 release 资产名：Windows 下是 .exe 安装器，macOS 下是 zip。
 */
export const downloadUpdate = async (
  info: IUpdateInfo,
  onProgress: (progress: IDownloadProgress) => void
): Promise<string> => {
  if (!info.assetUrl || !info.assetName) {
    throw new Error(
      isWindows ? '该 release 没有 Windows 安装器附件' : '该 release 没有 mac arm64 的 zip 附件'
    )
  }

  const dir = path.join(app.getPath('userData'), 'updates')
  await fs.promises.mkdir(dir, { recursive: true })
  const target = path.join(dir, info.assetName)

  const res = await net.fetch(info.assetUrl, { headers: { 'User-Agent': 'MoMark-Updater' } })

  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length')) || info.assetSize || 0
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let received = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    chunks.push(chunk)
    received += chunk.length
    onProgress({ received, total })
  }

  await fs.promises.writeFile(target, Buffer.concat(chunks))
  log.info(`[updater] downloaded ${target} (${received} bytes)`)

  return target
}

/**
 * 把更新包解开成「可直接用于安装的本地产物」的路径。
 *
 * - macOS：解压 zip 到临时目录，返回 `.app` 路径，供 osascript 复制到
 *   `/Applications`。
 * - Windows：NSIS 安装器是自解压的，直接返回 .exe 路径即可——这一步在
 *   Windows 上没有真实工作可做。
 */
export const extractUpdate = async (downloadedPath: string): Promise<string> => {
  if (isWindows) {
    // NSIS 自解压：没有独立解压阶段。下一步 installUpdate 直接 spawn 它。
    return downloadedPath
  }

  // macOS：用 `ditto -x -k` 而不是 unzip：ditto 保留 bundle 里的符号链接与
  // 扩展属性（Electron 的 Framework 里有 symlink，unzip 会解开成副本，撑爆
  // 体积且可能破坏签名结构）。
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'momark-update-'))
  await new Promise<void>((resolve, reject) => {
    exec(`ditto -x -k ${JSON.stringify(downloadedPath)} ${JSON.stringify(dir)}`, (error) => {
      if (error) reject(new Error(`解压失败：${error.message}`))
      else resolve()
    })
  })

  const entries = await fs.promises.readdir(dir)
  const appName = entries.find((name) => name.endsWith('.app'))

  if (!appName) throw new Error('压缩包里没有 .app')

  return path.join(dir, appName)
}

/**
 * 安装已就绪的更新产物并准备重启。
 *
 * - macOS：提权跑一段 shell，等墨记退出 → 替换目标 app → `xattr -cr` →
 *   `open` 新版。
 * - Windows：直接 spawn NSIS 安装器（`/S` 静默），它会自动替换运行中的
 *   `momark.exe`（在我们 app.quit 之后）并完成文件/快捷方式更新。
 *   用户级安装（`perMachine: false`）无需 UAC。
 */
export const installUpdate = async (installerPath: string): Promise<void> => {
  if (isWindows) {
    return installWindows(installerPath)
  }
  return installMacos(installerPath)
}

const installMacos = async (extractedAppPath: string): Promise<void> => {
  // 当前运行的 app bundle（…/墨记.app）；开发态（electron-vite dev）没有这个
  // 层级，installUpdate 只对打包产物有意义。
  const appBundle = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '')
  const targetApp = appBundle.endsWith('.app') ? appBundle : '/Applications/墨记.app'

  const script = [
    'set -e',
    `while pgrep -f ${JSON.stringify(targetApp)} > /dev/null 2>&1; do sleep 0.5; done`,
    `rm -rf ${JSON.stringify(targetApp)}`,
    `ditto ${JSON.stringify(extractedAppPath)} ${JSON.stringify(targetApp)}`,
    `xattr -cr ${JSON.stringify(targetApp)}`,
    `open ${JSON.stringify(targetApp)}`
  ].join('; ')

  log.info('[updater] installing to', targetApp)

  await new Promise<void>((resolve, reject) => {
    // osascript 的字符串里同时含单双引号，这里统一走双引号并转义内层双引号。
    const escaped = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    exec(
      `osascript -e "do shell script \\"${escaped}\\" with administrator privileges"`,
      (error) => {
        if (error) reject(new Error(`安装失败：${error.message}`))
        else resolve()
      }
    )
  })
}

const installWindows = async (installerPath: string): Promise<void> => {
  log.info('[updater] launching NSIS installer (silent)', installerPath)

  // 直接 spawn .exe 并 `/S` 静默；detached 让安装器进程独立于当前 Electron
  // 进程，unref() 阻止 Node 事件循环因它挂起。安装器需要把 momark.exe 替换
  // 成新版本，所以必须在我们 app.quit() 释放文件锁之后才动——安装器会
  // 自己重试或等待，本进程先退出就够。
  const child = spawn(installerPath, ['/S'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', (err) => {
    log.error('[updater] failed to spawn installer:', err)
  })
  child.unref()

  // 给安装器 ~1s 时间启动并把自己的临时文件准备好，再退出本进程释放文件锁。
  // 安装器后续会接管替换 momark.exe 的工作。
  await new Promise<void>((resolve) => setTimeout(resolve, 1000))
}

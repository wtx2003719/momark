import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import fs from 'fs'
import { launchWithMarkdown, waitForMenuReady, sendIpcToRenderer } from './helpers'

// 2026-10-08 — 保存过之后，外部程序再改动文件，墨记收不到变更（检测失灵）。
//
// 根因：同一文件被登记了两个 chokidar 文件 watcher（主进程 openTab 一次 +
// 渲染层 NEW_TAB_WITH_CONTENT 的 window-add-file-path 又一次）。macOS 上同一
// 路径的两个 fs.watch 句柄，在文件被 rename 替换（保存走 write-file-atomic）
// 后一起失效——之后该文件的外部改动永远收不到，直到标签重开。
//
// 本用例驱动真实管线：应用内保存（写盘 → rename）→ 1.2s 后外部改写 → 标签
// 必须变脏（默认 autoSave 关闭时外部变更会弹「文件已在磁盘上更改」并把标签
// 置脏）。修复前该断言超时失败。

const isDirty = (page: Page) =>
  page.evaluate(() => !!document.querySelector('.editor-tabs .tab.dirty'))

const waitForMtimeChange = async (
  file: string,
  sinceMs: number,
  timeout = 8000
): Promise<boolean> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(file).mtimeMs > sinceMs) return true
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  return false
}

test.describe('external change after an in-app save', () => {
  test('an external rewrite 1.2s after saving still marks the tab unsaved', async () => {
    const { app, page, filePath } = await launchWithMarkdown('base content\n')
    await waitForMenuReady(app)
    // The lazily-created preference store defaults autoSave to true; force it
    // off so the external change takes the banner + dirty path (the behavior a
    // user sees), not the silent auto-reload path.
    await sendIpcToRenderer(app, 'mt::user-preference', { autoSave: false })
    await page.waitForTimeout(500)
    expect(await isDirty(page)).toBe(false)

    // In-app save (same path the Save menu item takes: renderer FILE_SAVE →
    // main writeMarkdownFile → window-file-saved). Wait until the app wrote.
    const before = fs.statSync(filePath).mtimeMs
    await sendIpcToRenderer(app, 'mt::editor-ask-file-save')
    expect(await waitForMtimeChange(filePath, before)).toBe(true)

    // The old bug: the save's rename-over killed both duplicate watchers, so
    // anything written after this point was never detected.
    await page.waitForTimeout(1200)
    fs.writeFileSync(filePath, 'base content\nexternally changed\n', 'utf-8')

    await expect.poll(() => isDirty(page), { timeout: 8000 }).toBe(true)

    // The tab is dirty on purpose now; closing the window would open the
    // "unsaved changes" dialog and hang the test. Save once so close is clean.
    await sendIpcToRenderer(app, 'mt::editor-ask-file-save')
    await page.waitForTimeout(500)
    await app.close()
  })

  test('an external rewrite right after saving (inside the write-settle window) is detected', async () => {
    // chokidar 的 awaitWriteFinish 会把「自己的保存」和紧随其后的外部写合并成
    // 同一条事件；只按时间窗口吞事件的旧逻辑会把外部改动一起丢掉。
    const { app, page, filePath } = await launchWithMarkdown('base content\n')
    await waitForMenuReady(app)
    await sendIpcToRenderer(app, 'mt::user-preference', { autoSave: false })
    await page.waitForTimeout(500)

    const before = fs.statSync(filePath).mtimeMs
    await sendIpcToRenderer(app, 'mt::editor-ask-file-save')
    expect(await waitForMtimeChange(filePath, before)).toBe(true)

    await page.waitForTimeout(300)
    fs.writeFileSync(filePath, 'base content\nexternally changed fast\n', 'utf-8')

    await expect.poll(() => isDirty(page), { timeout: 8000 }).toBe(true)

    await sendIpcToRenderer(app, 'mt::editor-ask-file-save')
    await page.waitForTimeout(500)
    await app.close()
  })
})

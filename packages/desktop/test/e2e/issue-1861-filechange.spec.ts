import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import fs from 'fs'
import { launchWithMarkdown, waitForMenuReady, sendIpcToRenderer } from './helpers'

// #1861 — rewriting the open file on disk with byte-identical content (e.g. a
// git checkout that left it unchanged) fires a watcher 'change', but must NOT
// mark the tab unsaved or show the "file changed on disk" banner. A genuinely
// different on-disk content must still warn.
//
// This drives the REAL watcher: it writes the actual file and lets the
// main-process chokidar watcher -> loadMarkdownFile -> renderer handler run,
// rather than hand-crafting the IPC payload (which would tautologically match).

// The dirty marker moved to the tab-chip UI (`.tab.dirty`); the old
// `.editor-tabs li.unsaved` selector silently matched nothing, which had made
// this spec vacuous (2026-10-08).
const isDirty = (page: Page) =>
  page.evaluate(() => !!document.querySelector('.editor-tabs .tab.dirty'))

// awaitWriteFinish (stabilityThreshold 1000ms) defers the change event until
// the write settles, so a disk write surfaces ~1–2s later.
const WATCH_SETTLE = 2500

test.describe('Issue #1861 — content-identical file change', () => {
  test('an identical on-disk rewrite stays clean; a real change warns', async () => {
    const { app, page, filePath } = await launchWithMarkdown('hello\nworld\n')
    await waitForMenuReady(app)
    await page.waitForTimeout(500)
    expect(await isDirty(page)).toBe(false)

    // Identical bytes — the watcher fires, but the tab must stay clean.
    fs.writeFileSync(filePath, 'hello\nworld\n', 'utf-8')
    await page.waitForTimeout(WATCH_SETTLE)
    expect(await isDirty(page)).toBe(false)

    // A genuine content change still marks the tab unsaved.
    fs.writeFileSync(filePath, 'hello\nworld\nchanged\n', 'utf-8')
    await expect.poll(() => isDirty(page), { timeout: 8000 }).toBe(true)

    // The tab is dirty by design here; closing would open the "unsaved
    // changes" dialog and hang the test. Save once so the close is clean.
    await sendIpcToRenderer(app, 'mt::editor-ask-file-save')
    await page.waitForTimeout(500)
    await app.close()
  })
})

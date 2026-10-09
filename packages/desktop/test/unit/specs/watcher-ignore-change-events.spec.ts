import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// 2026-10-08：保存后 ~1s 内的外部写会被 chokidar 的 awaitWriteFinish 合并进
// 「自己保存」的那条 change 事件；旧逻辑只按时间窗口吞事件，会把合并进来的
// 外部改动一起丢掉（用户可见：文件被其他程序更新后，墨记检测失灵）。这里
// 钉住判据：只有当盘上 mtime 仍是这次保存写下的那份时，才当作自己的写吞掉。

vi.mock('chokidar', () => ({
  default: { watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })) }
}))
vi.mock('ced', () => ({ default: () => 'UTF-8' }))

import Watcher, { SELF_WRITE_MTIME_EPSILON } from 'main_renderer/filesystem/watcher'

describe('watcher ignore-change-events (save vs coalesced external write)', () => {
  let dir: string
  let file: string
  let watcher: Watcher

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momark-watcher-ignore-'))
    file = path.join(dir, 'note.md')
    fs.writeFileSync(file, 'base content\n')
    watcher = new Watcher({ getItem: vi.fn(() => false) } as never)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('ignores the event while the file is still exactly what we wrote', async () => {
    watcher.ignoreChangedEvent(1, file, 5000)
    expect(await watcher._shouldIgnoreEvent(1, file, 'file', false)).toBe(true)
  })

  it('forwards the event when the file was written again after our save', async () => {
    watcher.ignoreChangedEvent(1, file, 5000)
    // 模拟紧随其后的外部写：mtime 被推进到登记时刻之后（容差以外）。
    const future = new Date(Date.now() + SELF_WRITE_MTIME_EPSILON + 1000)
    fs.utimesSync(file, future, future)
    expect(await watcher._shouldIgnoreEvent(1, file, 'file', false)).toBe(false)
  })

  it('still drops a late event (cloud re-sync) as long as mtime never moved', async () => {
    watcher.ignoreChangedEvent(1, file, 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await watcher._shouldIgnoreEvent(1, file, 'file', false)).toBe(true)
  })

  it('consumes the entry so a second event is forwarded', async () => {
    watcher.ignoreChangedEvent(1, file, 5000)
    expect(await watcher._shouldIgnoreEvent(1, file, 'file', false)).toBe(true)
    expect(await watcher._shouldIgnoreEvent(1, file, 'file', false)).toBe(false)
  })

  it('never ignores events for other windows or paths', async () => {
    watcher.ignoreChangedEvent(1, file, 5000)
    expect(await watcher._shouldIgnoreEvent(2, file, 'file', false)).toBe(false)
    expect(await watcher._shouldIgnoreEvent(1, `${file}.other.md`, 'file', false)).toBe(false)
  })
})

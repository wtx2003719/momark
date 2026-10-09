import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// vitest 默认把 CSS import 打成空串（本包未开 css: true 处理），直接从磁盘读
// 源文件；vitest 以包根（packages/desktop）为 cwd。
const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8')
const tokensCss = read('src/renderer/src/assets/styles/tokens.css')
const editorCss = read('src/renderer/src/assets/styles/claude-editor.css')

// 2026-10-09（用户实测）：Claude 主题原先把 H1-H3 钉成固定 px（30/17/16），
// H4 往下没管、仍走引擎的相对字号（1.25em×15px=18.75px）——H4 比 H3 还大、
// 层级倒挂。修法是补 H4-H6 的固定字号。这里钉住两条性质：
//   ① 令牌里 H1-H6 全部显式定义且严格递减（H4 起落回正文 15px 以内）；
//   ② 主题样式对每一级都用 var(--hN-size) 取字号，不允许再漏级。

const sizeOf = (css: string, level: string): number => {
  const m = css.match(new RegExp(`--${level}-size:\\s*([0-9.]+)px`))
  expect(m, `--${level}-size 未定义`).toBeTruthy()
  return Number(m![1])
}

describe('Claude 主题标题字号阶梯', () => {
  const levels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']

  it('tokens.css：H1-H6 逐级递减，H4 起不超过正文 15px', () => {
    const sizes = levels.map((l) => sizeOf(tokensCss, l))
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i], `${levels[i]} 应小于 ${levels[i - 1]}`).toBeLessThan(sizes[i - 1])
    }
    expect(sizes[0]).toBe(30)
    expect(sizes[3]).toBeLessThanOrEqual(15)
  })

  it('claude-editor.css：每一级标题都用 var(--hN-size) 取字号（不漏 h4-h6）', () => {
    for (const l of levels) {
      expect(editorCss).toContain(`font-size: var(--${l}-size);`)
    }
  })
})

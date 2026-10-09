// @vitest-environment happy-dom

import type Content from '../../block/base/content'
import type TreeNode from '../../block/base/treeNode'
import type { Muya } from '../../muya'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import TableBodyCell from '../../block/gfm/table/cell'
import { Muya as MuyaEditor } from '../../muya'

// 2026-10-08 实测崩溃：外部重载/切标签的竞态里，`activeContentBlock` 仍指向
// 旧块，而它的祖先链已中途断开——`_caretPathKey` 裸取 `block.path` 抛
// `Cannot destructure property 'path' of 'this.parent' as it is null.`，
// 异常从 `_runRelocate` 一路抛回渲染循环（渲染进程「意外的错误」弹窗）。
// 修复：取路径整段兜住，取不到只是没法跳过光标块，按不跳过继续。
// （同因的 `highlightsFor` 已在 fa7efbbb 兜住，这里钉住增量重定位这一处。）

const DOC = ['第一段。', '', '| a | b |', '| --- | --- |', '| c | d |', ''].join('\n')

const booted: Muya[] = []

beforeEach(() => {
    booted.length = 0
})

afterEach(() => {
    while (booted.length) {
        const muya = booted.pop()!
        muya.destroy()
        muya.domNode.remove()
    }
})

function bootMuya(markdown: string): Muya {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const muya = new MuyaEditor(host, { markdown } as ConstructorParameters<typeof MuyaEditor>[1])
    muya.init()
    booted.push(muya)
    return muya
}

function contentBlocks(muya: Muya): Content[] {
    const blocks: Content[] = []
    muya.editor.scrollPage!.depthFirstTraverse((node: TreeNode) => {
        if (node.isContent())
            blocks.push(node)
    })
    return blocks
}

function firstCell(muya: Muya): TableBodyCell {
    let cell: TableBodyCell | null = null
    muya.editor.scrollPage!.depthFirstTraverse((node: TreeNode) => {
        if (!cell && node instanceof TableBodyCell)
            cell = node
    })
    return cell!
}

interface AnnotationInternals {
    _runRelocate(): void
    _deferred: Set<string>
}

describe('标注增量重定位：祖先链中途断开的块不崩溃', () => {
    it('_runRelocate 遇 path 链断裂的 activeContentBlock 时不抛异常、不跳过任何条目', () => {
        const muya = bootMuya(DOC)
        const [para] = contentBlocks(muya)

        // 至少一条标注，否则 `_runRelocate` 会在取光标路径前提前返回。
        const annotation = muya.annotation.addFromSnapshot(
            {
                anchor: { offset: 0, block: para!, path: para!.path },
                focus: { offset: 1, block: para!, path: para!.path },
                anchorBlock: para!,
                focusBlock: para!,
                anchorPath: para!.path,
                focusPath: para!.path,
            },
            '备注',
        )
        expect(annotation).not.toBeNull()

        // 复现崩溃状态：单元格（内容块的直接父级）的 parent 被置空——内容块还活着，
        // 路径链在中间断开。这正是重载竞态里测到的形态（堆栈 get path → get path）。
        const cell = firstCell(muya)
        const content = cell.children.head as Content
        ;(cell as unknown as { parent: null }).parent = null
        expect(() => content.path).toThrow(/Cannot destructure property 'path'/)

        // 旧实现这里会把异常抛出去；现在应为静默降级。
        const internals = muya.annotation as unknown as AnnotationInternals
        ;(
            muya.editor as unknown as { _activeContentBlock: Content }
        )._activeContentBlock = content

        expect(() => internals._runRelocate()).not.toThrow()
        // 路径读不出来 = 无法判断光标归属，不做跳过（宁可不跳，不要漏掉重定位）。
        expect(internals._deferred.size).toBe(0)
    })
})

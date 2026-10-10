// @vitest-environment happy-dom

import type Content from '../../block/base/content';
import type { Muya } from '../../muya';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Muya as MuyaClass } from '../../muya';
import { SelectionCaretType, SelectionDirection } from '../../selection/types';

// 反向选择（从下往上拖）跨列表项的复制。回归：`resolveSelectionOrder` 只用
// outMostBlock 的 scroll-page 偏移排两端，而同一 outmost block 内两端偏移相等、
// 被恒判成 anchor 在前 —— 起点取到选区尾部（截出空串）、终点取到头部（截出
// 空串），中间条目全被丢弃，复制一整段列表只剩「1. / 2.」空骨架（用户实测
// 粘贴出来「只有序号，每行一个」）。方向必须以选区自身的 direction 为准。

const MD = '1. ssss\n\n2. 222\n\n3. dfwefg\n';

vi.mock('../../utils/prism/index', () => ({
    default: {},
    walkTokens: () => null,
    loadedLanguages: new Set(),
    transformAliasToOrigin: (s: string) => s,
    loadLanguage: () => null,
    search: () => [],
}));

const bootedHosts: HTMLElement[] = [];

beforeEach(() => {
    window.MUYA_VERSION = 'test';
});

afterEach(() => {
    while (bootedHosts.length)
        bootedHosts.pop()!.remove();
    delete (window as Partial<Window>).MUYA_VERSION;
});

function bootMuya(markdown: string): Muya {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const muya = new MuyaClass(host, { markdown } as ConstructorParameters<typeof MuyaClass>[1]);
    muya.init();
    bootedHosts.push(muya.domNode);
    return muya;
}

function stubBackwardSelection(
    muya: Muya,
    anchorBlock: Content,
    anchorOffset: number,
    focusBlock: Content,
    focusOffset: number,
) {
    muya.editor.selection.getSelection = () => ({
        anchor: { offset: anchorOffset, block: anchorBlock, path: anchorBlock.path },
        focus: { offset: focusOffset, block: focusBlock, path: focusBlock.path },
        isCollapsed: false,
        isSelectionInSameBlock: false,
        direction: SelectionDirection.BACKWARD,
        type: SelectionCaretType.RANGE,
    });
}

function allContents(muya: Muya): Content[] {
    const out: Content[] = [];
    let c: Content | null = muya.editor.scrollPage!.firstContentInDescendant();
    while (c) {
        out.push(c);
        c = c.nextContentInContext() ?? null;
    }
    return out;
}

describe('backward selection copy across list items', () => {
    it('copies the whole selected range, not empty boundary items', () => {
        const muya = bootMuya(MD);
        const contents = allContents(muya);
        const first = contents.find(c => c.text === 'ssss')!;
        const last = contents.find(c => c.text === 'dfwefg')!;

        // 拖拽起点在底部（anchor=dfwefg 尾），终点在顶部（focus=ssss 头）
        stubBackwardSelection(muya, last, last.text.length, first, 0);

        const { text } = muya.editor.clipboard.getClipboardData();

        expect(text).toBe('1. ssss\n\n2. 222\n\n3. dfwefg\n');
    });

    it('truncates the boundary items to the caret on a partial backward range', () => {
        const muya = bootMuya(MD);
        const contents = allContents(muya);
        const first = contents.find(c => c.text === 'ssss')!;
        const last = contents.find(c => c.text === 'dfwefg')!;

        // 从底部 "dfwefg" 中段向上选到 "ssss" 中段
        stubBackwardSelection(muya, last, 2, first, 2);

        const { text } = muya.editor.clipboard.getClipboardData();

        expect(text).toBe('1. ss\n\n2. 222\n\n3. df\n');
    });

    it('real DOM selection set bottom-up (setBaseAndExtent) copies the same range', () => {
        const muya = bootMuya(MD);
        const findText = (needle: string): Text => {
            const walker = document.createTreeWalker(muya.domNode, 4);
            let n = walker.nextNode();
            while (n) {
                if ((n as Text).data.includes(needle))
                    return n as Text;

                n = walker.nextNode();
            }
            throw new Error(`no text node containing ${needle}`);
        };

        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.setBaseAndExtent(
            findText('dfwefg'),
            'dfwefg'.length,
            findText('ssss'),
            0,
        );

        expect(muya.editor.selection.getSelection()?.direction)
            .toBe(SelectionDirection.BACKWARD);

        const { text } = muya.editor.clipboard.getClipboardData();

        expect(text).toBe('1. ssss\n\n2. 222\n\n3. dfwefg\n');
    });
});

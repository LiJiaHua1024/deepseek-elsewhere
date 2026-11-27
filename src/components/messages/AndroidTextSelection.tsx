import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { android } from '../../app/android.js'
import { useAndroidBackInterception } from '../../app/useAndroidBackInterception.js'
import { useTranslate } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import { IconCopyOutline16, IconSelectAllOutline16 } from '../base/icons.js'
import { findScrollContainer } from './scrollContext.js'
import styles from './AndroidTextSelection.module.css'

type TextSegment = {
  kind: 'text'
  node: Text
  start: number
  end: number
}

type AtomicSegment = {
  kind: 'atomic'
  element: HTMLElement
  text: string
  display: boolean
  start: number
  end: number
}

type SelectionSegment = TextSegment | AtomicSegment

type OffsetRange = {
  start: number
  end: number
}

type RectBox = {
  left: number
  top: number
  width: number
  height: number
}

type AnchorPoint = {
  x: number
  y: number
  height: number
}

type VisualLayout = {
  highlights: RectBox[]
  startAnchor: AnchorPoint
  endAnchor: AnchorPoint
  toolbarTop: number
  toolbarLeft: number
  toolbarVisible: boolean
}

type SelectionBounds = {
  minRelTop: number
  maxRelBottom: number
  firstRel: RectBox
  lastRel: RectBox
  startAnchor: AnchorPoint
  endAnchor: AnchorPoint
}

const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, th, [data-latex-display="true"]'
const INLINE_SELECTOR =
  'p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, th, span, a, code, em, strong, del'
const IGNORED_SELECTOR = '[aria-hidden="true"], button, [role="toolbar"], .katex-mathml, .ds-markdown-cite'
const HANDLE_SIZE = 22
const TOOLBAR_MARGIN = 12
const TAP_SLOP = 8

const collectSegments = (
  root: HTMLElement
): { segments: SelectionSegment[]; totalLength: number } => {
  const segments: SelectionSegment[] = []
  let totalLength = 0

  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.hasAttribute('data-latex')) {
        const latex = (el.getAttribute('data-latex') ?? '').trim()
        if (latex.length > 0) {
          segments.push({
            kind: 'atomic',
            element: el,
            text: latex,
            display: el.getAttribute('data-latex-display') === 'true',
            start: totalLength,
            end: totalLength + 1,
          })
          totalLength += 1
        }
        return
      }
      if (el !== root && el.matches(IGNORED_SELECTOR)) {
        return
      }
      for (let child = el.firstChild; child; child = child.nextSibling) {
        walk(child)
      }
      return
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text
      const parent = textNode.parentElement
      const value = textNode.nodeValue ?? ''
      if (
        parent &&
        value.length > 0 &&
        !parent.closest(IGNORED_SELECTOR) &&
        (/\S/.test(value) || parent.closest(INLINE_SELECTOR))
      ) {
        const start = totalLength
        const end = start + value.length
        segments.push({ kind: 'text', node: textNode, start, end })
        totalLength = end
      }
    }
  }

  walk(root)
  return { segments, totalLength }
}

const getDisplayMathRect = (el: HTMLElement): DOMRect | null => {
  const clipRect = el.getBoundingClientRect()
  const katexHtml = el.querySelector('.katex-html')
  let minLeft = Number.POSITIVE_INFINITY
  let minTop = Number.POSITIVE_INFINITY
  let maxRight = Number.NEGATIVE_INFINITY
  let maxBottom = Number.NEGATIVE_INFINITY

  if (katexHtml) {
    for (const child of Array.from(katexHtml.children)) {
      const rect = child.getBoundingClientRect()
      if (rect.width > 0.5 && rect.height > 0.5) {
        minLeft = Math.min(minLeft, rect.left)
        minTop = Math.min(minTop, rect.top)
        maxRight = Math.max(maxRight, rect.right)
        maxBottom = Math.max(maxBottom, rect.bottom)
      }
    }
  }

  if (!Number.isFinite(minLeft)) {
    const fallback = (el.querySelector('.katex') ?? el).getBoundingClientRect()
    minLeft = fallback.left
    minTop = fallback.top
    maxRight = fallback.right
    maxBottom = fallback.bottom
  }

  const left = Math.max(minLeft, clipRect.left)
  const right = Math.min(maxRight, clipRect.right)
  const top = Math.max(minTop, clipRect.top)
  const bottom = Math.min(maxBottom, clipRect.bottom)
  const width = right - left
  const height = bottom - top
  return width > 0.5 && height > 0.5 ? new DOMRect(left, top, width, height) : null
}

const getSubRangeRects = (seg: SelectionSegment, rangeStart: number, rangeEnd: number): DOMRect[] => {
  if (rangeEnd <= seg.start || rangeStart >= seg.end) {
    return []
  }
  if (seg.kind === 'atomic') {
    if (seg.display) {
      const rect = getDisplayMathRect(seg.element)
      return rect ? [rect] : []
    }
    const rect = seg.element.getBoundingClientRect()
    return rect.width > 0.5 && rect.height > 0.5 ? [rect] : []
  }
  const localStart = Math.max(0, rangeStart - seg.start)
  const localEnd = Math.min(seg.end - seg.start, rangeEnd - seg.start)
  if (localEnd <= localStart) {
    return []
  }
  const range = document.createRange()
  range.setStart(seg.node, localStart)
  range.setEnd(seg.node, localEnd)
  return [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5)
}

const getAllSelectedClientRects = (
  segments: SelectionSegment[],
  start: number,
  end: number
): DOMRect[] => {
  const rects: DOMRect[] = []
  for (const seg of segments) {
    if (seg.end <= start) {
      continue
    }
    if (seg.start >= end) {
      break
    }
    rects.push(...getSubRangeRects(seg, start, end))
  }
  return rects
}

const findBlockScope = (
  element: Element | null,
  root: HTMLElement
): Element | null => {
  let cursor: Element | null = element
  while (cursor && cursor !== root && root.contains(cursor)) {
    if (cursor.matches(BLOCK_SELECTOR)) {
      return cursor
    }
    cursor = cursor.parentElement
  }
  return null
}

const getSegmentElement = (seg: SelectionSegment): Element | null =>
  seg.kind === 'text' ? seg.node.parentElement : seg.element

const segmentBelongsToBlock = (
  seg: SelectionSegment,
  block: Element,
  isListItem: boolean
): boolean => {
  if (isListItem) {
    return getSegmentElement(seg)?.closest('li') === block
  }
  return seg.kind === 'text'
    ? block.contains(seg.node)
    : block === seg.element || block.contains(seg.element)
}

const findInitialBlockOffsets = (
  segments: SelectionSegment[],
  totalLength: number,
  contentEl: HTMLElement,
  point?: { x: number; y: number }
): OffsetRange => {
  if (totalLength === 0) {
    return { start: 0, end: 0 }
  }
  if (!point) {
    return { start: 0, end: totalLength }
  }
  const hitEl = document.elementFromPoint(point.x, point.y)
  let block = hitEl && contentEl.contains(hitEl) ? findBlockScope(hitEl, contentEl) : null

  if (!block) {
    let bestDistance = Number.POSITIVE_INFINITY
    let bestSegment: SelectionSegment | null = null
    for (const seg of segments) {
      for (const rect of getSubRangeRects(seg, seg.start, seg.end)) {
        const dx = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0
        const dy = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0
        const dist = dx * dx + dy * dy
        if (dist < bestDistance) {
          bestDistance = dist
          bestSegment = seg
        }
      }
    }
    if (bestSegment) {
      block = findBlockScope(getSegmentElement(bestSegment), contentEl)
    }
  }

  if (!block) {
    return { start: 0, end: totalLength }
  }

  const isListItem = block.tagName === 'LI'
  let start = -1
  let end = -1
  for (const seg of segments) {
    if (segmentBelongsToBlock(seg, block, isListItem)) {
      if (start === -1) {
        start = seg.start
      }
      end = seg.end
    }
  }
  return start >= 0 && end > start ? { start, end } : { start: 0, end: totalLength }
}

const caretOffsetInSegments = (
  segments: SelectionSegment[],
  node: Node | null,
  offset: number
): number | null => {
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    return null
  }
  for (const seg of segments) {
    if (seg.kind === 'text' && seg.node === node) {
      return seg.start + Math.max(0, Math.min(seg.end - seg.start, offset))
    }
  }
  return null
}

const resolveOffsetGeometric = (
  segments: SelectionSegment[],
  totalLength: number,
  clientX: number,
  clientY: number
): number => {
  if (segments.length === 0) {
    return 0
  }
  type SegRect = { seg: SelectionSegment; rect: DOMRect; centerY: number }
  const boxes: SegRect[] = []
  for (const seg of segments) {
    for (const rect of getSubRangeRects(seg, seg.start, seg.end)) {
      boxes.push({ seg, rect, centerY: (rect.top + rect.bottom) / 2 })
    }
  }
  if (boxes.length === 0) {
    return 0
  }

  let firstTop = boxes[0].rect.top
  let lastBottom = boxes[0].rect.bottom
  let lineHeight = boxes[0].rect.height
  for (const box of boxes) {
    if (box.rect.top < firstTop) {
      firstTop = box.rect.top
    }
    if (box.rect.bottom > lastBottom) {
      lastBottom = box.rect.bottom
    }
    if (box.rect.height > lineHeight) {
      lineHeight = box.rect.height
    }
  }
  if (clientY < firstTop - lineHeight) {
    return 0
  }
  if (clientY > lastBottom + lineHeight) {
    return totalLength
  }

  // Find vertically closest line band.
  let minDy = Number.POSITIVE_INFINITY
  let bestCenterY = boxes[0].centerY
  for (const box of boxes) {
    const dy =
      clientY < box.rect.top
        ? box.rect.top - clientY
        : clientY > box.rect.bottom
          ? clientY - box.rect.bottom
          : 0
    if (dy < minDy || (dy === minDy && Math.abs(clientY - box.centerY) < Math.abs(clientY - bestCenterY))) {
      minDy = dy
      bestCenterY = box.centerY
    }
  }

  const band = boxes.filter(
    (box) => Math.abs(box.centerY - bestCenterY) <= Math.max(10, box.rect.height * 0.65)
  )
  const candidates = band.length > 0 ? band : [boxes[0]]
  candidates.sort((a, b) => a.rect.left - b.rect.left)

  let chosen = candidates[0]
  if (clientX <= candidates[0].rect.left) {
    chosen = candidates[0]
  } else if (clientX >= candidates[candidates.length - 1].rect.right) {
    chosen = candidates[candidates.length - 1]
  } else {
    let bestDx = Number.POSITIVE_INFINITY
    for (const item of candidates) {
      const dx =
        clientX < item.rect.left
          ? item.rect.left - clientX
          : clientX > item.rect.right
            ? clientX - item.rect.right
            : 0
      if (dx < bestDx) {
        bestDx = dx
        chosen = item
      }
    }
  }

  if (chosen.seg.kind === 'atomic') {
    const midX = (chosen.rect.left + chosen.rect.right) / 2
    return clientX >= midX ? chosen.seg.end : chosen.seg.start
  }

  // Pick character offset inside chosen Text node via binary search.
  const len = chosen.seg.end - chosen.seg.start
  const probe = document.createRange()
  let lo = 0
  let hi = len
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    probe.setStart(chosen.seg.node, mid)
    probe.setEnd(chosen.seg.node, Math.min(len, mid + 1))
    const rects = [...probe.getClientRects()].filter((r) => r.height > 0.5)
    if (rects.length === 0) {
      lo = mid + 1
      continue
    }
    const targetRect =
      rects.find((r) => Math.abs((r.top + r.bottom) / 2 - bestCenterY) <= r.height * 0.7) ?? rects[0]
    const midX = (targetRect.left + targetRect.right) / 2
    if (targetRect.bottom < bestCenterY - targetRect.height * 0.5) {
      lo = mid + 1
    } else if (targetRect.top > bestCenterY + targetRect.height * 0.5) {
      hi = mid
    } else if (clientX >= midX) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return chosen.seg.start + lo
}

const resolveOffsetAtPoint = (
  segments: SelectionSegment[],
  totalLength: number,
  clientX: number,
  clientY: number
): number => {
  const docWithCaret = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  if (typeof docWithCaret.caretPositionFromPoint === 'function') {
    const pos = docWithCaret.caretPositionFromPoint(clientX, clientY)
    const resolved = caretOffsetInSegments(segments, pos?.offsetNode ?? null, pos?.offset ?? 0)
    if (resolved !== null) {
      return resolved
    }
  } else if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(clientX, clientY)
    const resolved = caretOffsetInSegments(
      segments,
      range?.startContainer ?? null,
      range?.startOffset ?? 0
    )
    if (resolved !== null) {
      return resolved
    }
  }
  return resolveOffsetGeometric(segments, totalLength, clientX, clientY)
}

const countTrailingNewlines = (text: string, current: number): number => {
  let count = 0
  for (let i = text.length - 1; i >= 0 && text[i] === '\n'; i--) {
    count += 1
  }
  return count === text.length ? current + count : count
}

const extractTextForRange = (segments: SelectionSegment[], start: number, end: number): string => {
  const parts: string[] = []
  let prevBlock: Element | null = null
  let trailingNewlines = 0
  for (const seg of segments) {
    if (seg.end <= start) {
      continue
    }
    if (seg.start >= end) {
      break
    }
    let slice = ''
    let block: Element | null = null
    if (seg.kind === 'atomic') {
      slice = seg.text
      block = seg.display ? seg.element : (seg.element.closest(BLOCK_SELECTOR) ?? null)
    } else {
      const localStart = Math.max(0, start - seg.start)
      const localEnd = Math.min(seg.end - seg.start, end - seg.start)
      if (localEnd <= localStart) {
        continue
      }
      slice = (seg.node.nodeValue ?? '').slice(localStart, localEnd)
      block = seg.node.parentElement?.closest(BLOCK_SELECTOR) ?? null
    }
    if (prevBlock && block !== prevBlock && parts.length > 0) {
      const needed = prevBlock.tagName === 'LI' && block?.tagName === 'LI' ? 1 : 2
      if (trailingNewlines < needed) {
        const sep = '\n'.repeat(needed - trailingNewlines)
        parts.push(sep)
        trailingNewlines = needed
      }
    }
    parts.push(slice)
    trailingNewlines = countTrailingNewlines(slice, trailingNewlines)
    prevBlock = block
  }
  return parts.join('')
}

const computeViewportOverlay = (
  containerEl: HTMLElement,
  scrollEl: HTMLElement | null,
  bounds: SelectionBounds,
  toolbarWidth: number,
  toolbarHeight: number
) => {
  const rootRect = containerEl.getBoundingClientRect()
  const scrollRect = scrollEl
    ? scrollEl.getBoundingClientRect()
    : new DOMRect(0, 0, window.innerWidth, window.innerHeight)

  const minTop = rootRect.top + bounds.minRelTop
  const maxBottom = rootRect.top + bounds.maxRelBottom
  const firstTop = rootRect.top + bounds.firstRel.top
  const lastBottom = rootRect.top + bounds.lastRel.top + bounds.lastRel.height
  const firstLeft = rootRect.left + bounds.firstRel.left
  const lastRight = rootRect.left + bounds.lastRel.left + bounds.lastRel.width

  const toolbarVisible = maxBottom > scrollRect.top + 1 && minTop < scrollRect.bottom - 1
  const safeTop = Math.max(TOOLBAR_MARGIN, scrollRect.top + 8)
  const safeBottom = Math.min(window.innerHeight - TOOLBAR_MARGIN, scrollRect.bottom - 8)

  let toolbarTop: number
  if (
    firstTop >= scrollRect.top &&
    firstTop - toolbarHeight - 10 >= safeTop &&
    firstTop - toolbarHeight - 10 <= safeBottom - toolbarHeight
  ) {
    toolbarTop = firstTop - toolbarHeight - 10
  } else if (
    lastBottom <= scrollRect.bottom &&
    lastBottom + HANDLE_SIZE + 14 + toolbarHeight <= safeBottom &&
    lastBottom + HANDLE_SIZE + 14 >= safeTop
  ) {
    toolbarTop = lastBottom + HANDLE_SIZE + 14
  } else {
    toolbarTop = Math.max(safeTop, Math.min(safeBottom - toolbarHeight, firstTop - toolbarHeight - 10))
  }

  const selectionCenterX =
    Math.abs(bounds.firstRel.top - bounds.lastRel.top) < 1
      ? (firstLeft + lastRight) / 2
      : (rootRect.left + rootRect.right) / 2
  const toolbarLeft = Math.max(
    TOOLBAR_MARGIN,
    Math.min(window.innerWidth - toolbarWidth - TOOLBAR_MARGIN, selectionCenterX - toolbarWidth / 2)
  )

  return { toolbarTop, toolbarLeft, toolbarVisible }
}

/**
 * 自由选词/字符级选择浮层：
 * 以真实文本节点 Range 几何为基准，提供可拖拽水滴手柄与浮动操作栏（复制 / 全选）。
 */
export const AndroidTextSelection = ({
  active,
  containerRef,
  contentRef,
  initialMode = 'block',
  initialPoint,
  fullCopyText,
  onExit,
}: {
  active: boolean
  containerRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  initialMode?: 'block' | 'all'
  initialPoint?: { x: number; y: number }
  fullCopyText?: string
  onExit: () => void
}) => {
  const t = useTranslate()
  const [range, setRange] = useState<OffsetRange | null>(null)
  const [totalLength, setTotalLength] = useState(0)
  const [layout, setLayout] = useState<VisualLayout | null>(null)
  const [dragging, setDragging] = useState(false)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ anchor: number; verticalBias: number } | null>(null)
  const rangeRef = useRef<OffsetRange | null>(null)
  const boundsRef = useRef<SelectionBounds | null>(null)
  const toolbarSizeRef = useRef<{ width: number; height: number } | null>(null)
  const pendingTapRef = useRef<{
    pointerId: number
    x: number
    y: number
    insideContainer: boolean
    moved: boolean
    scrolled: boolean
  } | null>(null)
  const suppressClickCleanupRef = useRef<(() => void) | null>(null)
  rangeRef.current = range

  useAndroidBackInterception(active)

  useEffect(() => () => suppressClickCleanupRef.current?.(), [])

  // Initialize range when entering selection mode.
  useLayoutEffect(() => {
    if (!active) {
      setRange(null)
      setLayout(null)
      setTotalLength(0)
      setDragging(false)
      dragRef.current = null
      boundsRef.current = null
      pendingTapRef.current = null
      return
    }
    const contentEl = contentRef.current
    if (!contentEl) {
      return
    }
    window.getSelection()?.removeAllRanges()
    const { segments, totalLength: total } = collectSegments(contentEl)
    setTotalLength(total)
    if (total === 0) {
      onExit()
      return
    }
    if (initialMode === 'all') {
      setRange({ start: 0, end: total })
    } else {
      setRange(findInitialBlockOffsets(segments, total, contentEl, initialPoint))
    }
  }, [active, contentRef, initialMode, initialPoint, onExit])

  const getToolbarSize = useCallback(
    (current: OffsetRange) => {
      if (toolbarRef.current) {
        const size = {
          width: toolbarRef.current.offsetWidth || 134,
          height: toolbarRef.current.offsetHeight || 54,
        }
        toolbarSizeRef.current = size
        return size
      }
      if (toolbarSizeRef.current) {
        return toolbarSizeRef.current
      }
      return {
        width: current.start === 0 && current.end === totalLength ? 68 : 134,
        height: 54,
      }
    },
    [totalLength]
  )

  const syncExclusionRects = useCallback(
    (bounds: SelectionBounds | null) => {
      const containerEl = containerRef.current
      if (!android?.setSelectionExclusion) {
        return
      }
      if (!active || !bounds || !containerEl) {
        android.setSelectionExclusion(0, 0, 0, 0, 0, 0, 0, 0, false)
        return
      }
      const rootRect = containerEl.getBoundingClientRect()
      const scrollEl = findScrollContainer(containerEl)
      const scrollRect = scrollEl
        ? scrollEl.getBoundingClientRect()
        : new DOMRect(0, 0, window.innerWidth, window.innerHeight)

      const sx = rootRect.left + bounds.startAnchor.x
      const sy = rootRect.top + bounds.startAnchor.y
      const ex = rootRect.left + bounds.endAnchor.x
      const ey = rootRect.top + bounds.endAnchor.y
      const startVisible = sy >= scrollRect.top - 12 && sy <= scrollRect.bottom + 12
      const endVisible = ey >= scrollRect.top - 12 && ey <= scrollRect.bottom + 12

      if (!startVisible && !endVisible) {
        android.setSelectionExclusion(0, 0, 0, 0, 0, 0, 0, 0, false)
        return
      }
      android.setSelectionExclusion(
        startVisible ? sx - 44 : 0,
        startVisible ? sy - 12 : 0,
        startVisible ? sx + 16 : 0,
        startVisible ? sy + 52 : 0,
        endVisible ? ex - 16 : 0,
        endVisible ? ey - 12 : 0,
        endVisible ? ex + 44 : 0,
        endVisible ? ey + 52 : 0,
        true
      )
    },
    [active, containerRef]
  )

  const recomputeLayout = useCallback(() => {
    const containerEl = containerRef.current
    const contentEl = contentRef.current
    const current = rangeRef.current
    if (!active || !containerEl || !contentEl || !current) {
      boundsRef.current = null
      setLayout(null)
      return
    }
    const { segments } = collectSegments(contentEl)
    const clientRects = getAllSelectedClientRects(segments, current.start, current.end)
    if (clientRects.length === 0) {
      boundsRef.current = null
      setLayout(null)
      return
    }
    const rootRect = containerEl.getBoundingClientRect()
    const highlights: RectBox[] = clientRects.map((rect) => ({
      left: rect.left - rootRect.left,
      top: rect.top - rootRect.top,
      width: rect.width,
      height: rect.height,
    }))
    let minRelTop = highlights[0].top
    let maxRelBottom = highlights[0].top + highlights[0].height
    for (const box of highlights) {
      if (box.top < minRelTop) {
        minRelTop = box.top
      }
      if (box.top + box.height > maxRelBottom) {
        maxRelBottom = box.top + box.height
      }
    }
    const first = clientRects[0]
    const last = clientRects[clientRects.length - 1]
    const bounds: SelectionBounds = {
      minRelTop,
      maxRelBottom,
      firstRel: highlights[0],
      lastRel: highlights[highlights.length - 1],
      startAnchor: {
        x: first.left - rootRect.left,
        y: first.bottom - rootRect.top,
        height: first.height,
      },
      endAnchor: {
        x: last.right - rootRect.left,
        y: last.bottom - rootRect.top,
        height: last.height,
      },
    }
    boundsRef.current = bounds

    const scrollEl = findScrollContainer(containerEl)
    const { width: toolbarWidth, height: toolbarHeight } = getToolbarSize(current)
    const overlay = computeViewportOverlay(containerEl, scrollEl, bounds, toolbarWidth, toolbarHeight)

    setLayout({
      highlights,
      startAnchor: bounds.startAnchor,
      endAnchor: bounds.endAnchor,
      ...overlay,
    })
  }, [active, containerRef, contentRef, getToolbarSize])

  const updateOverlayOnScroll = useCallback(() => {
    const containerEl = containerRef.current
    const bounds = boundsRef.current
    const current = rangeRef.current
    if (!active || !containerEl || !bounds || !current) {
      return
    }
    const scrollEl = findScrollContainer(containerEl)
    const { width: toolbarWidth, height: toolbarHeight } = getToolbarSize(current)
    const overlay = computeViewportOverlay(containerEl, scrollEl, bounds, toolbarWidth, toolbarHeight)
    setLayout((prev) => {
      if (
        !prev ||
        (prev.toolbarTop === overlay.toolbarTop &&
          prev.toolbarLeft === overlay.toolbarLeft &&
          prev.toolbarVisible === overlay.toolbarVisible)
      ) {
        return prev
      }
      return { ...prev, ...overlay }
    })
    syncExclusionRects(bounds)
  }, [active, containerRef, getToolbarSize, syncExclusionRects])

  useLayoutEffect(() => {
    recomputeLayout()
  }, [range, dragging, recomputeLayout])

  // Prevent Android edge-back gesture from hijacking visible handle drags near the screen edge.
  useEffect(() => {
    if (!active || !layout) {
      android?.setSelectionExclusion?.(0, 0, 0, 0, 0, 0, 0, 0, false)
      return
    }
    syncExclusionRects(boundsRef.current)
    return () => {
      android?.setSelectionExclusion?.(0, 0, 0, 0, 0, 0, 0, 0, false)
    }
  }, [active, layout, syncExclusionRects])

  // Keep layout synced with scroll / viewport / content changes, and dismiss only on non-scroll tap or back/Escape/outside contextmenu.
  useEffect(() => {
    if (!active) {
      return
    }
    let scrollRaf = 0
    let resizeRaf = 0
    const scheduleScrollUpdate = () => {
      if (pendingTapRef.current) {
        pendingTapRef.current.scrolled = true
      }
      cancelAnimationFrame(scrollRaf)
      scrollRaf = requestAnimationFrame(updateOverlayOnScroll)
    }
    const scheduleFullRecompute = () => {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(recomputeLayout)
    }
    const suppressNextClickOnContainer = () => {
      const containerEl = containerRef.current
      if (!containerEl) {
        return
      }
      suppressClickCleanupRef.current?.()
      const onClickCapture = (event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        suppressClickCleanupRef.current?.()
      }
      const timer = window.setTimeout(() => {
        suppressClickCleanupRef.current?.()
      }, 350)
      suppressClickCleanupRef.current = () => {
        window.clearTimeout(timer)
        containerEl.removeEventListener('click', onClickCapture, true)
        suppressClickCleanupRef.current = null
      }
      containerEl.addEventListener('click', onClickCapture, true)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
        return
      }
      const target = event.target instanceof Node ? event.target : null
      if (target instanceof Element && target.closest('[data-selection-interactive="true"]')) {
        pendingTapRef.current = null
        return
      }
      pendingTapRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        insideContainer: Boolean(target && containerRef.current?.contains(target)),
        moved: false,
        scrolled: false,
      }
    }
    const onPointerMove = (event: PointerEvent) => {
      const tap = pendingTapRef.current
      if (!tap || tap.pointerId !== event.pointerId || tap.moved) {
        return
      }
      if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_SLOP) {
        tap.moved = true
      }
    }
    const onPointerCancel = (event: PointerEvent) => {
      if (pendingTapRef.current?.pointerId === event.pointerId) {
        pendingTapRef.current = null
      }
    }
    const onPointerUp = (event: PointerEvent) => {
      const tap = pendingTapRef.current
      if (!tap || tap.pointerId !== event.pointerId) {
        return
      }
      pendingTapRef.current = null
      if (tap.moved || tap.scrolled) {
        return
      }
      if (tap.insideContainer) {
        suppressNextClickOnContainer()
      }
      onExit()
    }
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null
      if (!target || !containerRef.current?.contains(target)) {
        pendingTapRef.current = null
        onExit()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onExit()
      }
    }
    const onAndroidBack = () => {
      onExit()
    }
    const contentEl = contentRef.current
    const resizeObserver = contentEl ? new ResizeObserver(scheduleFullRecompute) : null
    if (contentEl && resizeObserver) {
      resizeObserver.observe(contentEl)
    }
    window.addEventListener('scroll', scheduleScrollUpdate, true)
    window.addEventListener('resize', scheduleFullRecompute)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerCancel, true)
    document.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('android-back', onAndroidBack)
    return () => {
      cancelAnimationFrame(scrollRaf)
      cancelAnimationFrame(resizeRaf)
      resizeObserver?.disconnect()
      window.removeEventListener('scroll', scheduleScrollUpdate, true)
      window.removeEventListener('resize', scheduleFullRecompute)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
      document.removeEventListener('contextmenu', onContextMenu, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('android-back', onAndroidBack)
    }
  }, [active, containerRef, contentRef, onExit, recomputeLayout, updateOverlayOnScroll])

  // Track active handle drag across the whole window.
  useEffect(() => {
    if (!dragging) {
      return
    }
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current
      const contentEl = contentRef.current
      if (!drag || !contentEl) {
        return
      }
      const { segments, totalLength: total } = collectSegments(contentEl)
      if (total === 0) {
        return
      }
      const scrollEl = findScrollContainer(containerRef.current)
      const scrollRect = scrollEl
        ? scrollEl.getBoundingClientRect()
        : new DOMRect(0, 0, window.innerWidth, window.innerHeight)
      const targetY = Math.max(
        scrollRect.top + 4,
        Math.min(scrollRect.bottom - 4, event.clientY - drag.verticalBias)
      )
      const next = resolveOffsetAtPoint(segments, total, event.clientX, targetY)
      if (next === drag.anchor) {
        const start = Math.max(0, drag.anchor - 1)
        const end = start === drag.anchor ? Math.min(total, drag.anchor + 1) : drag.anchor
        setRange({ start, end })
      } else {
        setRange({ start: Math.min(drag.anchor, next), end: Math.max(drag.anchor, next) })
      }
    }
    const onUp = () => {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [containerRef, contentRef, dragging])

  if (!active || !layout || !range) {
    return null
  }

  const allSelected = range.start === 0 && range.end === totalLength

  const beginDrag = (kind: 'start' | 'end') => (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointer events may not have an active OS pointer id.
    }
    const anchorPoint = kind === 'start' ? layout.startAnchor : layout.endAnchor
    const containerRect = containerRef.current?.getBoundingClientRect()
    const lineCenterY = containerRect
      ? containerRect.top + anchorPoint.y - anchorPoint.height / 2
      : event.clientY
    dragRef.current = {
      anchor: kind === 'start' ? range.end : range.start,
      verticalBias: Math.max(0, Math.min(anchorPoint.height * 0.9, event.clientY - lineCenterY)),
    }
    setDragging(true)
  }

  const handleCopy = () => {
    const contentEl = contentRef.current
    if (!contentEl) {
      onExit()
      return
    }
    const { segments } = collectSegments(contentEl)
    const selected =
      range.start === 0 && range.end === totalLength && fullCopyText
        ? fullCopyText
        : extractTextForRange(segments, range.start, range.end)
    if (selected) {
      void copyText(selected).then((copied) =>
        showToast({ key: copied ? 'copied' : 'copyFailed' }, copied ? 1990 : undefined)
      )
    }
    onExit()
  }

  const handleSelectAll = () => {
    const contentEl = contentRef.current
    if (!contentEl) {
      return
    }
    const { totalLength: total } = collectSegments(contentEl)
    setTotalLength(total)
    setRange({ start: 0, end: total })
  }

  return (
    <>
      <div className={styles.highlightLayer} aria-hidden="true">
        {layout.highlights.map((box, index) => (
          <span
            key={index}
            className={styles.highlight}
            style={{
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
            }}
          />
        ))}
      </div>
      <button
        type="button"
        className={clsx(styles.handle, styles.handleStart)}
        data-selection-interactive="true"
        data-drawer-gesture-ignore=""
        aria-label={t('androidSelectText')}
        style={{
          left: layout.startAnchor.x,
          top: layout.startAnchor.y,
        }}
        onPointerDown={beginDrag('start')}
        onClick={(event) => event.stopPropagation()}
      >
        <span className={styles.teardrop} />
      </button>
      <button
        type="button"
        className={clsx(styles.handle, styles.handleEnd)}
        data-selection-interactive="true"
        data-drawer-gesture-ignore=""
        aria-label={t('androidSelectText')}
        style={{
          left: layout.endAnchor.x,
          top: layout.endAnchor.y,
        }}
        onPointerDown={beginDrag('end')}
        onClick={(event) => event.stopPropagation()}
      >
        <span className={styles.teardrop} />
      </button>
      {!dragging && layout.toolbarVisible
        ? createPortal(
            <div
              ref={toolbarRef}
              className={styles.toolbar}
              data-selection-interactive="true"
              data-drawer-gesture-ignore=""
              role="toolbar"
              style={{
                top: layout.toolbarTop,
                left: layout.toolbarLeft,
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <button type="button" onClick={handleCopy}>
                <IconCopyOutline16 />
                <span>{t('copy')}</span>
              </button>
              {!allSelected ? (
                <button type="button" onClick={handleSelectAll}>
                  <IconSelectAllOutline16 />
                  <span>{t('selectAll')}</span>
                </button>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

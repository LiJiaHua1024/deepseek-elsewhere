import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeLongImageSlices,
  isLongImageDimensions,
} from '../src/elsewhere/attachments/longImage.js'
import {
  buildPdfAttachmentText,
  decidePdfMode,
  isNativePdfRejectionError,
  normalizeLinePieces,
  MAX_PDF_TEXT_CHARS,
  NATIVE_PDF_MAX_BYTES,
} from '../src/elsewhere/attachments/pdfExtract.js'
import { AttachmentPreprocessCache } from '../src/elsewhere/attachments/cache.js'
import { ApiError } from '../src/services/api/client.js'

test('普通手机单屏截图不触发长图切分', () => {
  assert.equal(isLongImageDimensions(1080, 2340), false)
  assert.equal(computeLongImageSlices(1080, 2340).length, 0)
})

test('竖长图保持宽度并按 64 到 100 像素重叠切片，末片对齐底边', () => {
  const slices = computeLongImageSlices(1080, 7600)
  assert.ok(slices.length >= 2)
  assert.ok(slices.every((slice) => slice.outWidth === 1080))
  for (let index = 1; index < slices.length; index++) {
    const previous = slices[index - 1]
    const current = slices[index]
    const overlap = previous.sy + previous.sh - current.sy
    const scaledOverlap = (overlap / 7600) * 7600
    assert.ok(scaledOverlap >= 63 && scaledOverlap <= 101, `overlap ${scaledOverlap}`)
  }
  const last = slices.at(-1)
  assert.ok(last)
  assert.equal(Math.round(last.sy + last.sh), 7600)
})

test('极长图收敛到最多十片且首尾完整', () => {
  const slices = computeLongImageSlices(1080, 30000)
  assert.ok(slices.length <= 10)
  assert.equal(slices[0]?.sy, 0)
  const last = slices.at(-1)
  assert.ok(last)
  assert.equal(Math.round(last.sy + last.sh), 30000)
})

test('超宽横图横向切分', () => {
  const slices = computeLongImageSlices(7200, 1080)
  assert.ok(slices.length >= 2)
  assert.ok(slices.every((slice) => slice.sy === 0 && slice.outHeight === 1080))
  assert.equal(Math.round((slices.at(-1)?.sx ?? 0) + (slices.at(-1)?.sw ?? 0)), 7200)
})

test('PDF 模式决策符合协议、偏好和大小限制', () => {
  assert.equal(decidePdfMode({ format: 'chat', preference: 'auto', size: 100 }), 'smart')
  assert.equal(
    decidePdfMode({ format: 'messages', preference: 'auto', size: NATIVE_PDF_MAX_BYTES }),
    'native'
  )
  assert.equal(
    decidePdfMode({ format: 'responses', preference: 'auto', size: NATIVE_PDF_MAX_BYTES + 1 }),
    'smart'
  )
  assert.equal(decidePdfMode({ format: 'messages', preference: 'local', size: 100 }), 'smart')
  assert.equal(
    decidePdfMode({ format: 'messages', preference: 'auto', size: 100, customMode: 'pdf_text' }),
    'text'
  )
  assert.equal(
    decidePdfMode({ format: 'messages', preference: 'auto', size: 100, customMode: 'pdf_images' }),
    'images'
  )
})

test('PDF 文本在换行边界截断并带计数', () => {
  const pages = Array.from({ length: 30 }, (_, index) => ({
    page: index + 1,
    text: `${index + 1}页\n` + '测试文字\n'.repeat(1800),
  }))
  const result = buildPdfAttachmentText('测试.pdf', 30, pages)
  assert.match(result.text, /\[已截断，仅保留前 \d+ 页文字，共 30 页\]/)
  assert.ok(result.text.length < MAX_PDF_TEXT_CHARS + 200)
  assert.ok(!result.text.endsWith('测试文</attachment>'))
})

test('预处理 LRU 缓存命中并按数量淘汰', () => {
  const cache = new AttachmentPreprocessCache()
  const block = { type: 'text' as const, text: 'x' }
  for (let index = 0; index < 8; index++) {
    cache.set(String(index), { blocks: [block], bytes: 10 })
  }
  cache.get('0')
  cache.set('8', { blocks: [block], bytes: 10 })
  assert.equal(cache.get('0') !== undefined, true)
  assert.equal(cache.get('1'), undefined)
  assert.equal(cache.size, 8)
})

test('原生 PDF 拒绝错误只匹配可降级响应', () => {
  assert.equal(isNativePdfRejectionError(new ApiError('http', 'unsupported document', 400)), true)
  assert.equal(isNativePdfRejectionError(new ApiError('http', 'too large', 413)), true)
  assert.equal(isNativePdfRejectionError(new ApiError('http', 'anything', 413)), true)
  assert.equal(isNativePdfRejectionError(new ApiError('http', 'unauthorized', 401)), false)
  assert.equal(isNativePdfRejectionError(new ApiError('http', 'rate limited', 429)), false)
  assert.equal(isNativePdfRejectionError(new ApiError('http', 'bad request', 400)), false)
})

test('PDF 文本按行距与 hasEOL 恢复换行', () => {
  const text = normalizeLinePieces([
    { str: '第一行', transform: [10, 0, 0, 10, 0, 100], width: 30, hasEOL: true },
    { str: '第二行', transform: [10, 0, 0, 10, 0, 100], width: 30 },
    { str: '第三行', transform: [10, 0, 0, 10, 0, 86], width: 30 },
  ])
  assert.equal(text, ['第一行', '第二行', '第三行'].join('\n'))
})

test('PDF 文件名包裹边界转义引号与尖括号', () => {
  const result = buildPdfAttachmentText('a"<b>.pdf', 1, [{ page: 1, text: '内容' }])
  assert.ok(result.text.includes('<attachment name="a&quot;&lt;b&gt;.pdf"'))
})

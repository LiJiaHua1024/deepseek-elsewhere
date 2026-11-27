import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toMdAst } from '../src/services/markdown/parse.ts'

const parse = (lines, newline = '\n') =>
  toMdAst(lines.join(newline), { sources: undefined, disableLink: false }).children

test('列表中的公式续行退回正文时补齐缩进，并保留公式后的段落', () => {
  const limit = String.raw`\lim_{n \to \infty} \left| \frac{a_n}{a_{n-1}} \right| = 1`
  for (const newline of ['\n', '\r\n']) {
    const [list, after] = parse(
      ['1. First', '2. Limit', '   Compute the ratio.', '', '   \\[', limit, '\\]', 'After.'],
      newline
    )
    const formula = list.children[1].children[1]
    assert.equal(formula.type, 'math')
    assert.equal(formula.value, limit)
    assert.equal(after.type, 'paragraph')
    assert.equal(after.children[0].value, 'After.')
  }
})

test('嵌套列表内的公式与下一列表项各自独立', () => {
  const [list] = parse(['1. First', '   - Nested', '     \\[', 'x + 1', '\\]', '2. Next'])
  const nested = list.children[0].children[1]
  const formula = nested.children[0].children[1]
  assert.equal(formula.type, 'math')
  assert.equal(formula.value, 'x + 1')
  assert.equal(list.children[1].children[0].children[0].value, 'Next')
})

test('合法公式、围栏代码与未闭合公式保留各自的 Markdown 语义', () => {
  const [normal, inline] = parse(['1. Limit', '   \\[', '   x', '   \\]', '', '`\\[a\\]`'])
  assert.equal(normal.children[0].children[1].value, 'x')
  assert.equal(inline.children[0].type, 'inlineCode')
  assert.equal(inline.children[0].value, '\\[a\\]')

  const [list, code] = parse(['1. Limit', '   \\[', '```text', '\\frac{a}{b}', '\\]', '```'])
  assert.equal(list.children[0].children[1].value, '')
  assert.equal(code.type, 'code')
  assert.equal(code.value, '\\frac{a}{b}\n\\]')

  const [unfinished, prose] = parse(['1. Limit', '   \\[', 'Outside the list.'])
  assert.equal(unfinished.children[0].children[1].value, '')
  assert.equal(prose.children[0].value, 'Outside the list.')
})

test('量子力学长列表中的多组未缩进公式全部渲染且无孤立定界符', () => {
  const pauli = String.raw`\sigma_x = \begin{pmatrix} 0 & 1 \\ 1 & 0 \end{pmatrix}, \quad \sigma_y = \begin{pmatrix} 0 & -i \\ i & 0 \end{pmatrix}`
  const hamiltonian = String.raw`\hat{H} = -\mu_B \hbar B_0 (\sin\theta \sigma_x + \cos\theta \sigma_y)`
  const matrix = String.raw`\hat{H} = -\mu_B \hbar B_0 \begin{pmatrix} 0 & \sin\theta - i\cos\theta \\ \sin\theta + i\cos\theta & 0 \end{pmatrix}`

  const [list] = parse([
    '1. 泡利矩阵：',
    '   \\[',
    pauli,
    '\\]',
    '   代入哈密顿量：',
    '   \\[',
    hamiltonian,
    '\\]',
    '   写成矩阵形式：',
    '   \\[',
    matrix,
    '\\]',
  ])
  const children = list.children[0].children
  assert.equal(children[1].type, 'math')
  assert.equal(children[1].value, pauli)
  assert.equal(children[3].type, 'math')
  assert.equal(children[3].value, hamiltonian)
  assert.equal(children[5].type, 'math')
  assert.equal(children[5].value, matrix)
})

test('多个列表项中的未缩进公式各自独立修复', () => {
  const hamiltonian = String.raw`\hat{H} = -\mu_B \hbar B_0 (\sin\theta \sigma_x + \cos\theta \sigma_y)`
  const [list] = parse([
    '1. 第一步：',
    '   \\[',
    '\\sigma_x = 1',
    '\\]',
    '2. 第二步：',
    '   \\[',
    hamiltonian,
    '\\]',
    '   矩阵：',
    '   \\[',
    '\\hat{H} = 0',
    '\\]',
  ])
  assert.equal(list.children[0].children[1].type, 'math')
  assert.equal(list.children[0].children[1].value, '\\sigma_x = 1')
  assert.equal(list.children[1].children[1].type, 'math')
  assert.equal(list.children[1].children[1].value, hamiltonian)
  assert.equal(list.children[1].children[3].type, 'math')
  assert.equal(list.children[1].children[3].value, '\\hat{H} = 0')
})

test('支持公式首行带内容、尾行同行闭合以及公式内空行', () => {
  const [sameOpen] = parse(['1. 同行起始：', '   \\[ \\hat{H} = 1', '\\]'])
  assert.equal(sameOpen.children[0].children[1].type, 'math')
  assert.equal(sameOpen.children[0].children[1].value, '\\hat{H} = 1')

  const [sameClose] = parse(['1. 同行闭合：', '   \\[', '\\hat{H} = 2 \\]'])
  assert.equal(sameClose.children[0].children[1].type, 'math')
  assert.equal(sameClose.children[0].children[1].value.trim(), '\\hat{H} = 2')

  const [blankInside] = parse(['1. 含空行：', '   \\[', '', '\\hat{H} = 3', '', '\\]'])
  assert.equal(blankInside.children[0].children[1].type, 'math')
  assert.equal(blankInside.children[0].children[1].value, '\n\\hat{H} = 3\n')
})

test('支持列表中的 $$ 公式与引用块中的未缩进公式', () => {
  const [dollarList] = parse(['1. 推导：', '   $$', '\\hat{H} = E_0', '$$'])
  assert.equal(dollarList.children[0].children[1].type, 'math')
  assert.equal(dollarList.children[0].children[1].value, '\\hat{H} = E_0')

  const [quote] = parse(['> 推导：', '> \\[', '\\hat{H} = E_1', '\\]'])
  assert.equal(quote.type, 'blockquote')
  assert.equal(quote.children[1].type, 'math')
  assert.equal(quote.children[1].value, '\\hat{H} = E_1')
})

test('闭合定界符同行紧跟标点或文字时拆分后仍正确渲染', () => {
  const [math1, p1] = parse(['\\[', '\\hat{H} = 1', '\\]。'])
  assert.equal(math1.type, 'math')
  assert.equal(math1.value, '\\hat{H} = 1')
  assert.equal(p1.type, 'paragraph')
  assert.equal(p1.children[0].value, '。')

  const [math2, p2, math3] = parse(['\\[ x + y \\]，其中', '', '\\[', 'z = 1', '\\]'])
  assert.equal(math2.type, 'math')
  assert.equal(math2.value.trim(), 'x + y')
  assert.equal(p2.type, 'paragraph')
  assert.equal(p2.children[0].value, '，其中')
  assert.equal(math3.type, 'math')
  assert.equal(math3.value, 'z = 1')

  const [list] = parse(['1. 项：', '   \\[', 'a = 1', '\\]。'])
  assert.equal(list.children[0].children[1].type, 'math')
  assert.equal(list.children[0].children[1].value, 'a = 1')
  assert.equal(list.children[0].children[2].type, 'paragraph')
  assert.equal(list.children[0].children[2].children[0].value, '。')
})

test('矩阵换行与反斜杠转义括号不会误触发拆分，制表符缩进正常处理', () => {
  const matrixWithBracket = String.raw`\begin{pmatrix} a \\ ] \end{pmatrix}`
  const [matrixNode] = parse(['\\[', matrixWithBracket, '\\]'])
  assert.equal(matrixNode.type, 'math')
  assert.equal(matrixNode.value, matrixWithBracket)

  const [tabList] = parse(['1.\t制表符：', '\t\\[', 'x = 1', '\\]'])
  assert.equal(tabList.children[0].children[1].type, 'math')
  assert.equal(tabList.children[0].children[1].value, 'x = 1')

  const [inlineTick, prose] = parse(['1. 项：', '   \\[', '`\\]`'])
  assert.equal(inlineTick.children[0].children[1].value, '')
  assert.equal(prose.children[0].type, 'inlineCode')
  assert.equal(prose.children[0].value, '\\]')
})

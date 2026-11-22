import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fetchWebPage } from '../src/elsewhere/search/fetchPage.js'
import {
  extractReadableFromHtml,
  isReadableContentType,
  MAX_FETCH_CHARS,
  truncateFetchedText,
} from '../src/elsewhere/search/htmlExtract.js'
import type { HttpTransport } from '../src/elsewhere/search/http.js'
import { executeWebSearch } from '../src/elsewhere/search/providers.js'
import type { SearchEngineId, SearchToolsRuntimeConfig } from '../src/elsewhere/tools/types.js'

const makeConfig = (overrides: Partial<SearchToolsRuntimeConfig> = {}): SearchToolsRuntimeConfig => ({
  engine: 'deepseek',
  officialApiKey: 'ds-key',
  apiKeys: {
    bocha: 'bocha-key',
    exa: 'exa-key',
    tavily: 'tavily-key',
    brave: 'brave-key',
  },
  searxngUrl: 'https://searx.example.com/',
  webFetchMode: 'auto',
  useExternalOnOfficial: false,
  ...overrides,
})

describe('HTML extraction & truncation', () => {
  it('strips script/style/nav/footer/aside, prefers article/main, and extracts title + markdown', () => {
    const html = `<!doctype html>
<html>
  <head>
    <title>Test &amp; Docs</title>
    <style>body { color: red; }</style>
    <script>console.log("noise")</script>
  </head>
  <body>
    <nav><a href="https://example.com/home">Home</a></nav>
    <main>
      <h1>Main Heading</h1>
      <p>Hello <a href="https://example.com/guide">world</a> &mdash; this is the main article text with plenty of words so it meets the minimum length threshold.</p>
      <ul><li>Item one</li><li>Item two</li></ul>
      <pre>const x = 1;</pre>
    </main>
    <aside>Sidebar advertisement</aside>
    <footer>Copyright 2026</footer>
  </body>
</html>`

    const { title, text } = extractReadableFromHtml(html)
    assert.equal(title, 'Test & Docs')
    assert.match(text, /# Main Heading/)
    assert.match(text, /\[world\]\(https:\/\/example\.com\/guide\)/)
    assert.match(text, /- Item one/)
    assert.match(text, /const x = 1;/)
    assert.doesNotMatch(text, /console\.log/)
    assert.doesNotMatch(text, /color: red/)
    assert.doesNotMatch(text, /Sidebar advertisement/)
    assert.doesNotMatch(text, /Copyright 2026/)
    assert.doesNotMatch(text, /Home/)
  })

  it('truncates text over 12,000 chars and appends truncation marker', () => {
    const long = 'a'.repeat(15_000)
    const res = truncateFetchedText(long, MAX_FETCH_CHARS)
    assert.equal(res.truncated, true)
    assert.equal(res.charCount, 15_000)
    assert.ok(res.text.startsWith('a'.repeat(100)))
    assert.ok(res.text.endsWith('[Truncated: showing first 12000 of 15000 chars]'))
  })

  it('validates readable vs binary Content-Type', () => {
    assert.equal(isReadableContentType('text/html; charset=utf-8'), true)
    assert.equal(isReadableContentType('application/json'), true)
    assert.equal(isReadableContentType('application/ld+json'), true)
    assert.equal(isReadableContentType('application/pdf'), false)
    assert.equal(isReadableContentType('image/png'), false)
    assert.equal(isReadableContentType('application/octet-stream'), false)
  })
})

describe('fetchWebPage safety & fallback', () => {
  it('rejects non-http(s) URLs and binary responses', async () => {
    let called = false
    const transport: HttpTransport = async () => {
      called = true
      return { ok: true, status: 200, contentType: 'application/pdf', text: '%PDF-1.7' }
    }

    const fileRes = await fetchWebPage('file:///etc/passwd', makeConfig(), undefined, {
      isAndroid: true,
      transport,
    })
    assert.equal(fileRes.isError, true)
    assert.equal(called, false)

    const jsRes = await fetchWebPage('javascript:alert(1)', makeConfig(), undefined, {
      isAndroid: true,
      transport,
    })
    assert.equal(jsRes.isError, true)

    const pdfRes = await fetchWebPage('https://example.com/a.pdf', makeConfig(), undefined, {
      isAndroid: true,
      transport,
    })
    assert.equal(pdfRes.isError, true)
    assert.match(pdfRes.content, /non-text content/i)
  })

  it('falls back to DeepSeek fetch on Android when direct fetch returns 403', async () => {
    const urls: string[] = []
    const transport: HttpTransport = async (opts) => {
      urls.push(opts.url)
      if (opts.url === 'https://protected.example.com/post') {
        return { ok: false, status: 403, contentType: 'text/html', text: 'Forbidden' }
      }
      return {
        ok: true,
        status: 200,
        contentType: 'application/json',
        text: JSON.stringify({ title: 'Fallback Title', content: 'Recovered markdown body.' }),
      }
    }

    const res = await fetchWebPage('https://protected.example.com/post', makeConfig(), undefined, {
      isAndroid: true,
      transport,
    })
    assert.equal(res.isError, undefined)
    assert.deepEqual(urls, [
      'https://protected.example.com/post',
      'https://api.deepseek.com/v1/tools/fetch',
    ])
    assert.match(res.content, /Fallback Title/)
    assert.match(res.content, /Recovered markdown body\./)
  })
})

describe('6 search engine adapters', () => {
  const cases: {
    engine: SearchEngineId
    expectedUrlPrefix: string
    expectedAuthHeader: [string, string] | null
    responseJson: unknown
  }[] = [
    {
      engine: 'deepseek',
      expectedUrlPrefix: 'https://api.deepseek.com/v1/tools/search',
      expectedAuthHeader: ['Authorization', 'Bearer ds-key'],
      responseJson: {
        results: [
          {
            title: 'DS Result',
            url: 'https://ds.test/1',
            snippet: 'short',
            summary: 'longer ds summary',
            site_name: 'DS',
            site_icon: 'https://ds.test/ico.png',
            date: '2026-06-01T00:00:00Z',
          },
        ],
      },
    },
    {
      engine: 'bocha',
      expectedUrlPrefix: 'https://api.bochaai.com/v1/web-search',
      expectedAuthHeader: ['Authorization', 'Bearer bocha-key'],
      responseJson: {
        code: 200,
        data: {
          webPages: {
            value: [
              {
                name: 'Bocha Result',
                url: 'https://bocha.test/1',
                summary: 'bocha summary',
                siteName: 'BochaSite',
                datePublished: '2026-05-01T00:00:00Z',
              },
            ],
          },
        },
      },
    },
    {
      engine: 'exa',
      expectedUrlPrefix: 'https://api.exa.ai/search',
      expectedAuthHeader: ['x-api-key', 'exa-key'],
      responseJson: {
        results: [
          {
            title: 'Exa Result',
            url: 'https://exa.test/1',
            highlights: ['highlight 1', 'highlight 2'],
            publishedDate: '2026-04-01T00:00:00Z',
          },
        ],
      },
    },
    {
      engine: 'tavily',
      expectedUrlPrefix: 'https://api.tavily.com/search',
      expectedAuthHeader: ['Authorization', 'Bearer tavily-key'],
      responseJson: {
        results: [
          {
            title: 'Tavily Result',
            url: 'https://tavily.test/1',
            content: 'tavily content',
            published_date: '2026-03-01',
          },
        ],
      },
    },
    {
      engine: 'brave',
      expectedUrlPrefix: 'https://api.search.brave.com/res/v1/web/search?q=',
      expectedAuthHeader: ['X-Subscription-Token', 'brave-key'],
      responseJson: {
        web: {
          results: [
            {
              title: 'Brave Result',
              url: 'https://brave.test/1',
              description: 'brave description',
              page_age: '2026-02-01',
              profile: { name: 'BraveSite' },
            },
          ],
        },
      },
    },
    {
      engine: 'searxng',
      expectedUrlPrefix: 'https://searx.example.com/search?q=',
      expectedAuthHeader: null,
      responseJson: {
        results: [
          {
            title: 'SearXNG Result',
            url: 'https://searx.test/1',
            content: 'x'.repeat(500),
            publishedDate: '2026-01-01',
          },
          {
            title: 'Ignored non-http',
            url: 'javascript:bad()',
            content: 'bad',
          },
        ],
      },
    },
  ]

  for (const item of cases) {
    it(`normalizes results and enforces limits for ${item.engine}`, async () => {
      let seenUrl = ''
      let seenHeaders: Record<string, string> = {}
      const transport: HttpTransport = async (opts) => {
        seenUrl = opts.url
        seenHeaders = opts.headers ?? {}
        return {
          ok: true,
          status: 200,
          contentType: 'application/json',
          text: JSON.stringify(item.responseJson),
        }
      }

      const { results, text } = await executeWebSearch(
        'test query',
        50,
        makeConfig({ engine: item.engine }),
        undefined,
        transport
      )
      assert.ok(seenUrl.startsWith(item.expectedUrlPrefix), `Unexpected URL: ${seenUrl}`)
      if (item.expectedAuthHeader) {
        assert.equal(seenHeaders[item.expectedAuthHeader[0]], item.expectedAuthHeader[1])
      }
      assert.equal(results.length, 1)
      assert.ok(results[0].snippet.length <= 400)
      assert.ok(text.length <= 6_000)
    })
  }
})

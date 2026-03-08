import { mock, beforeEach, afterEach, test, expect, describe } from 'bun:test'

// ── Puppeteer mock ────────────────────────────────────────────────────────────

const mockClose = mock(() => Promise.resolve())
const mockGoto = mock(() => Promise.resolve({ ok: () => true, status: () => 200 } as any))
const mockContent = mock(() => Promise.resolve(''))

const mockPage = {
  setDefaultNavigationTimeout: mock(() => { }),
  setUserAgent: mock(() => Promise.resolve()),
  goto: mockGoto,
  content: mockContent,
  close: mockClose,
}

let _connected = true
let _disconnectedHandler: (() => void) | null = null

const mockBrowserClose = mock(() => Promise.resolve())
const mockBrowserOn = mock((event: string, handler: () => void) => {
  if (event === 'disconnected') _disconnectedHandler = handler
})
const mockNewPage = mock(() => Promise.resolve(mockPage as any))

const mockBrowser = {
  get connected() { return _connected },
  newPage: mockNewPage,
  on: mockBrowserOn,
  close: mockBrowserClose,
}

const mockLaunch = mock(() => {
  _connected = true
  return Promise.resolve(mockBrowser as any)
})

mock.module('puppeteer', () => ({
  default: { launch: mockLaunch },
}))

// ── Module under test ─────────────────────────────────────────────────────────

const { validateUrl, search, fetchPage, getBrowser, resetBrowser } =
  await import('./index')

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EMPTY_HTML = '<html><body></body></html>'
const ARTICLE_HTML = `<!DOCTYPE html>
<html><head><title>Test Article</title></head><body>
<article>
<h1>Test Article</h1>
<p>This is the first paragraph with substantial content for Readability to extract properly.</p>
<p>This is the second paragraph with more content to ensure the Readability parser functions correctly.</p>
<p>Third paragraph with additional content to meet the minimum content threshold requirements.</p>
</article>
</body></html>`

function makeDDGHtml(results: Array<{ title: string; url: string; snippet: string; isAd?: boolean }>) {
  const items = results.map(r => `
    <div class="result${r.isAd ? ' result--ad' : ''}">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}">${r.title}</a>
      <div class="result__snippet">${r.snippet}</div>
    </div>`).join('')
  return `<html><body>${items}</body></html>`
}

// ── Mock helpers ──────────────────────────────────────────────────────────────

function setupMocks(defaultContent = EMPTY_HTML) {
  resetBrowser()
  _connected = true
  mockLaunch.mockClear()
  mockNewPage.mockClear()
  mockClose.mockClear()
  mockGoto.mockImplementation(() => Promise.resolve({ ok: () => true, status: () => 200 } as any))
  mockContent.mockImplementation(() => Promise.resolve(defaultContent))
  mockLaunch.mockImplementation(() => {
    _connected = true
    return Promise.resolve(mockBrowser as any)
  })
}

const teardown = () => { resetBrowser(); _connected = true }

// ── 1. validateUrl ────────────────────────────────────────────────────────────

describe('validateUrl', () => {
  // 許可
  test('https:// を許可', () => expect(() => validateUrl('https://example.com')).not.toThrow())
  test('http:// を許可', () => expect(() => validateUrl('http://example.com')).not.toThrow())
  test('172.15.x.x はプライベート範囲外なので許可', () => expect(() => validateUrl('http://172.15.0.1')).not.toThrow())
  test('172.32.x.x はプライベート範囲外なので許可', () => expect(() => validateUrl('http://172.32.0.1')).not.toThrow())
  test('認証情報付きURLはhostnameのみチェック', () => expect(() => validateUrl('https://user:pass@example.com')).not.toThrow())
  test('Unicodeパスを許可', () => expect(() => validateUrl('https://example.com/path/あいう')).not.toThrow())
  test('非常に長いURLを許可', () => expect(() => validateUrl(`https://example.com/${'a'.repeat(2000)}`)).not.toThrow())

  // スキーム拒否
  test('file:// を拒否', () => expect(() => validateUrl('file:///etc/passwd')).toThrow('許可されていないスキーム'))
  test('ftp:// を拒否', () => expect(() => validateUrl('ftp://example.com')).toThrow('許可されていないスキーム'))
  test('javascript: を拒否', () => expect(() => validateUrl('javascript:alert(1)')).toThrow('許可されていないスキーム'))

  // プライベートIP拒否
  test('localhost を拒否', () => expect(() => validateUrl('http://localhost')).toThrow('プライベートIP'))
  test('LOCALHOST を拒否', () => expect(() => validateUrl('http://LOCALHOST')).toThrow('プライベートIP'))
  test('127.0.0.1 を拒否', () => expect(() => validateUrl('http://127.0.0.1')).toThrow('プライベートIP'))
  test('127.0.0.255 を拒否', () => expect(() => validateUrl('http://127.0.0.255')).toThrow('プライベートIP'))
  test('0.0.0.0 を拒否', () => expect(() => validateUrl('http://0.0.0.0')).toThrow('プライベートIP'))
  test('::1 を拒否', () => expect(() => validateUrl('http://[::1]')).toThrow('プライベートIP'))
  test('10.x.x.x を拒否', () => expect(() => validateUrl('http://10.0.0.1')).toThrow('プライベートIP'))
  test('192.168.x.x を拒否', () => expect(() => validateUrl('http://192.168.0.1')).toThrow('プライベートIP'))
  test('172.16.x.x を拒否（境界下限）', () => expect(() => validateUrl('http://172.16.0.1')).toThrow('プライベートIP'))
  test('172.31.x.x を拒否（境界上限）', () => expect(() => validateUrl('http://172.31.0.1')).toThrow('プライベートIP'))

  // 不正フォーマット
  test('不正フォーマットを拒否', () => expect(() => validateUrl('not-a-url')).toThrow('無効なURL'))

  // 動作ドキュメント（現在ブロックされない）
  test('169.254.169.254 は現在ブロックされない（AWSメタデータ）', () => {
    expect(() => validateUrl('http://169.254.169.254')).not.toThrow()
  })
  test('[::ffff:7f00:1] は現在ブロックされない（IPv4-mapped IPv6）', () => {
    expect(() => validateUrl('http://[::ffff:7f00:1]')).not.toThrow()
  })
  test('短縮IPv4（127.1）の動作ドキュメント', () => {
    const hostname = new URL('http://127.1').hostname
    if (hostname.startsWith('127.')) {
      expect(() => validateUrl('http://127.1')).toThrow('プライベートIP')
    } else {
      expect(hostname).toBe('127.1')
    }
  })
})

// ── 2. search ─────────────────────────────────────────────────────────────────

describe('search', () => {
  beforeEach(() => setupMocks())
  afterEach(teardown)

  test('3件の結果を正しくパースする', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'Title 1', url: 'https://example1.com', snippet: 'Snippet 1' },
      { title: 'Title 2', url: 'https://example2.com', snippet: 'Snippet 2' },
      { title: 'Title 3', url: 'https://example3.com', snippet: 'Snippet 3' },
    ]))

    const results = await search('test', 5)
    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ title: 'Title 1', url: 'https://example1.com', snippet: 'Snippet 1' })
    expect(results[1]!.url).toBe('https://example2.com')
    expect(results[2]!.title).toBe('Title 3')
  })

  test('uddg URLをデコードして復元する', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'Encoded', url: 'https://example.com/path?q=hello world', snippet: '' },
    ]))
    const results = await search('test', 5)
    expect(results[0]!.url).toBe('https://example.com/path?q=hello world')
  })

  test('.result--ad クラスをスキップする', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'Organic', url: 'https://organic.com', snippet: 'Real result' },
      { title: 'Ad Result', url: 'https://ad.com', snippet: 'Ad content', isAd: true },
      { title: 'Organic 2', url: 'https://organic2.com', snippet: 'Real result 2' },
    ]))
    const results = await search('test', 10)
    expect(results).toHaveLength(2)
    expect(results.every(r => r.url !== 'https://ad.com')).toBe(true)
  })

  test('広告除外後に limit 件でスライスする', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'T1', url: 'https://e1.com', snippet: '' },
      { title: 'Ad', url: 'https://ad.com', snippet: '', isAd: true },
      { title: 'T2', url: 'https://e2.com', snippet: '' },
      { title: 'T3', url: 'https://e3.com', snippet: '' },
      { title: 'T4', url: 'https://e4.com', snippet: '' },
    ]))
    expect(await search('test', 2)).toHaveLength(2)
  })

  test('.result 要素なし → 空配列', async () => {
    expect(await search('test', 5)).toHaveLength(0)
  })

  test('uddg パラメータなし → その要素をフィルタ', async () => {
    mockContent.mockResolvedValueOnce(`<html><body>
      <div class="result">
        <a class="result__a" href="/no-uddg">No uddg link</a>
        <div class="result__snippet">snippet</div>
      </div>
    </body></html>`)
    expect(await search('test', 5)).toHaveLength(0)
  })

  test('href 属性なし → その要素をフィルタ', async () => {
    mockContent.mockResolvedValueOnce(`<html><body>
      <div class="result">
        <a class="result__a">No href attribute</a>
        <div class="result__snippet">snippet</div>
      </div>
    </body></html>`)
    expect(await search('test', 5)).toHaveLength(0)
  })

  test('スニペット要素なし → snippet: "" で返す', async () => {
    mockContent.mockResolvedValueOnce(`<html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com')}">Title</a>
      </div>
    </body></html>`)
    const results = await search('test', 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.snippet).toBe('')
  })

  test('タイトルが空文字でも結果として返す', async () => {
    mockContent.mockResolvedValueOnce(`<html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com')}"></a>
        <div class="result__snippet">snippet</div>
      </div>
    </body></html>`)
    const results = await search('test', 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.title).toBe('')
  })

  test('不正な href URL → その要素をスキップして他を返す', async () => {
    mockContent.mockResolvedValueOnce(`<html><body>
      <div class="result">
        <a class="result__a" href="//invalid url with spaces">Bad URL</a>
        <div class="result__snippet">bad</div>
      </div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://good.com')}">Good</a>
        <div class="result__snippet">good</div>
      </div>
    </body></html>`)
    const results = await search('test', 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.url).toBe('https://good.com')
  })

  test('goto() がthrow → search全体がreject', async () => {
    mockGoto.mockRejectedValueOnce(new Error('Navigation failed'))
    await expect(search('test', 5)).rejects.toThrow('Navigation failed')
  })

  test('goto() タイムアウト → throw', async () => {
    mockGoto.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'))
    await expect(search('test', 5)).rejects.toThrow()
  })

  // 境界値・ファズ
  test('limit=1 → 1件のみ返す', async () => {
    mockContent.mockResolvedValueOnce(makeDDGHtml([
      { title: 'T1', url: 'https://e1.com', snippet: '' },
      { title: 'T2', url: 'https://e2.com', snippet: '' },
    ]))
    expect(await search('test', 1)).toHaveLength(1)
  })

  test('limit=20 → 最大20件返す', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ title: `T${i}`, url: `https://e${i}.com`, snippet: '' }))
    mockContent.mockResolvedValueOnce(makeDDGHtml(items))
    expect(await search('test', 20)).toHaveLength(20)
  })

  test("query に SQL インジェクション風文字", async () => {
    expect(Array.isArray(await search("' OR 1=1", 5))).toBe(true)
  })

  test('query に XSS風文字', async () => {
    expect(Array.isArray(await search('<script>alert(1)</script>', 5))).toBe(true)
  })

  test('query に日本語マルチバイト文字', async () => {
    expect(Array.isArray(await search('あいうえお', 5))).toBe(true)
  })

  test('query が空文字列 → 空配列', async () => {
    expect(await search('', 5)).toHaveLength(0)
  })
})

// ── 3. fetchPage ──────────────────────────────────────────────────────────────

describe('fetchPage', () => {
  beforeEach(() => setupMocks(ARTICLE_HTML))
  afterEach(teardown)

  test('Readability抽出 → "# タイトル\\n\\n本文" 形式', async () => {
    const result = await fetchPage('https://example.com')
    expect(result).toMatch(/^# Test Article\n\n/)
    expect(result).toContain('This is the first paragraph')
  })

  test('連続空行を \\n\\n に圧縮する', async () => {
    mockContent.mockImplementationOnce(() => Promise.resolve(`<!DOCTYPE html>
<html><head><title>Blank Lines Test</title></head><body>
<article>
<p>First paragraph with substantial content to pass Readability threshold.</p>


<p>Second paragraph after multiple blank lines in the source HTML content here.</p>


<p>Third paragraph for additional content required by Readability parser.</p>
</article>
</body></html>`))
    expect(await fetchPage('https://example.com')).not.toMatch(/\n{3,}/)
  })

  test('HTMLエンティティ &amp; → & としてデコードされる', async () => {
    mockContent.mockImplementationOnce(() => Promise.resolve(`<!DOCTYPE html>
<html><head><title>Test &amp; Article</title></head><body><article>
<h1>Test &amp; Article</h1>
<p>Content with &amp; entity and substantial text for Readability to parse properly here.</p>
<p>Second paragraph with more content to ensure the parser functions correctly for testing.</p>
<p>Third paragraph for additional content required by Readability parser threshold here.</p>
</article></body></html>`))
    const result = await fetchPage('https://example.com')
    expect(result).toContain('&')
    expect(result).not.toContain('&amp;')
  })

  test('HTTP 404 → throw', async () => {
    mockGoto.mockImplementationOnce(() =>
      Promise.resolve({ ok: () => false, status: () => 404 } as any))
    await expect(fetchPage('https://example.com')).rejects.toThrow('HTTPエラー 404')
  })

  test('Readability が null を返す → throw', async () => {
    mockContent.mockImplementationOnce(() =>
      Promise.resolve('<html><head><title>Empty</title></head><body></body></html>'))
    await expect(fetchPage('https://example.com')).rejects.toThrow('ページを読み取れませんでした')
  })

  test('goto() が null を返す → ok() チェックをスキップして正常続行', async () => {
    mockGoto.mockResolvedValueOnce(null)
    const result = await fetchPage('https://example.com')
    expect(result).toMatch(/^# Test Article/)
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  test('goto() がthrow → page.close() が finally で呼ばれる', async () => {
    mockClose.mockClear()
    mockGoto.mockRejectedValueOnce(new Error('Navigation timeout'))
    await expect(fetchPage('https://example.com')).rejects.toThrow('Navigation timeout')
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  test('newPage() がthrow → page.close() は呼ばれない', async () => {
    mockClose.mockClear()
    mockNewPage.mockRejectedValueOnce(new Error('newPage crash'))
    await expect(fetchPage('https://example.com')).rejects.toThrow('newPage crash')
    expect(mockClose).toHaveBeenCalledTimes(0)
  })

  test('例外発生時も page.close() が finally で呼ばれる', async () => {
    mockClose.mockClear()
    mockGoto.mockImplementationOnce(() =>
      Promise.resolve({ ok: () => false, status: () => 500 } as any))
    await expect(fetchPage('https://example.com')).rejects.toThrow()
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  test('launch失敗 → fetchPage全体がreject', async () => {
    mockLaunch.mockRejectedValueOnce(new Error('browser launch failed'))
    await expect(fetchPage('https://example.com')).rejects.toThrow('browser launch failed')
  })
})

// ── 4. getBrowser ─────────────────────────────────────────────────────────────

describe('getBrowser', () => {
  beforeEach(() => {
    resetBrowser()
    _connected = true
    _disconnectedHandler = null
    mockLaunch.mockClear()
    mockBrowserOn.mockClear()
    mockLaunch.mockImplementation(() => {
      _connected = true
      return Promise.resolve(mockBrowser as any)
    })
  })
  afterEach(teardown)

  test('初回は puppeteer.launch() を呼ぶ', async () => {
    await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(1)
  })

  test('2回目以降はキャッシュを返す（launch は1回のみ）', async () => {
    const b1 = await getBrowser()
    const b2 = await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(1)
    expect(b1).toBe(b2)
  })

  test('並列呼び出し → launch は1回のみ（競合防止）', async () => {
    const [b1, b2, b3] = await Promise.all([getBrowser(), getBrowser(), getBrowser()])
    expect(mockLaunch).toHaveBeenCalledTimes(1)
    expect(b1).toBe(b2)
    expect(b2).toBe(b3)
  })

  test('browser.connected = false → launch を再実行する', async () => {
    await getBrowser()
    _connected = false
    await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(2)
  })

  test('disconnected イベント後 → 次の getBrowser で再起動する', async () => {
    await getBrowser()
    expect(_disconnectedHandler).not.toBeNull()
    _disconnectedHandler!()
    mockLaunch.mockClear()
    await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(1)
  })

  test('launch失敗後 → 2回目は再試行できる', async () => {
    mockLaunch
      .mockRejectedValueOnce(new Error('launch failed'))
      .mockImplementationOnce(() => {
        _connected = true
        return Promise.resolve(mockBrowser as any)
      })
    await expect(getBrowser()).rejects.toThrow('launch failed')
    const b = await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(2)
    expect(b).toBeDefined()
  })
})

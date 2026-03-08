import { mock, beforeEach, afterEach, test, expect, describe } from 'bun:test'

// ── Fetch mock (search tests) ─────────────────────────────────────────────────

const mockFetch = mock(() => Promise.resolve({ text: () => Promise.resolve('') } as any))
global.fetch = mockFetch as any

// ── Puppeteer mock ────────────────────────────────────────────────────────────

const mockClose = mock(() => Promise.resolve())
const mockGoto = mock(() => Promise.resolve({ ok: () => true, status: () => 200 } as any))
const mockContent = mock(() => Promise.resolve(''))

const mockPage = {
  setDefaultNavigationTimeout: mock(() => {}),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDDGHtml(results: Array<{ title: string; url: string; snippet: string; isAd?: boolean }>) {
  const items = results.map(r => `
    <div class="result${r.isAd ? ' result--ad' : ''}">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}">${r.title}</a>
      <div class="result__snippet">${r.snippet}</div>
    </div>`).join('')
  return `<html><body>${items}</body></html>`
}

const ARTICLE_HTML = `<!DOCTYPE html>
<html><head><title>Test Article</title></head><body>
<article>
<h1>Test Article</h1>
<p>This is the first paragraph with substantial content for Readability to extract properly.</p>
<p>This is the second paragraph with more content to ensure the Readability parser functions correctly.</p>
<p>Third paragraph with additional content to meet the minimum content threshold requirements.</p>
</article>
</body></html>`

// ═══════════════════════════════════════════════════════════════════════════════
// 1. validateUrl — セキュリティテスト
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateUrl', () => {
  // 正常系
  test('https:// URL を許可', () => {
    expect(() => validateUrl('https://example.com')).not.toThrow()
  })

  test('http:// URL を許可', () => {
    expect(() => validateUrl('http://example.com')).not.toThrow()
  })

  test('172.15.0.1 はプライベート範囲外なので許可', () => {
    expect(() => validateUrl('http://172.15.0.1')).not.toThrow()
  })

  test('172.32.0.1 はプライベート範囲外なので許可', () => {
    expect(() => validateUrl('http://172.32.0.1')).not.toThrow()
  })

  // スキーム拒否
  test('file:// スキームを拒否', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow('許可されていないスキーム')
  })

  test('ftp:// スキームを拒否', () => {
    expect(() => validateUrl('ftp://example.com')).toThrow('許可されていないスキーム')
  })

  // プライベートIP拒否
  test('localhost を拒否', () => {
    expect(() => validateUrl('http://localhost')).toThrow('プライベートIP')
  })

  test('127.0.0.1 を拒否', () => {
    expect(() => validateUrl('http://127.0.0.1')).toThrow('プライベートIP')
  })

  test('127.0.0.255 を拒否（境界）', () => {
    expect(() => validateUrl('http://127.0.0.255')).toThrow('プライベートIP')
  })

  test('10.0.0.1 を拒否', () => {
    expect(() => validateUrl('http://10.0.0.1')).toThrow('プライベートIP')
  })

  test('192.168.0.1 を拒否', () => {
    expect(() => validateUrl('http://192.168.0.1')).toThrow('プライベートIP')
  })

  test('172.16.0.1 を拒否（境界下限）', () => {
    expect(() => validateUrl('http://172.16.0.1')).toThrow('プライベートIP')
  })

  test('172.31.0.1 を拒否（境界上限）', () => {
    expect(() => validateUrl('http://172.31.0.1')).toThrow('プライベートIP')
  })

  test('0.0.0.0 を拒否', () => {
    expect(() => validateUrl('http://0.0.0.0')).toThrow('プライベートIP')
  })

  test('::1 を拒否', () => {
    expect(() => validateUrl('http://[::1]')).toThrow('プライベートIP')
  })

  // 不正フォーマット
  test('不正フォーマットを拒否', () => {
    expect(() => validateUrl('not-a-url')).toThrow('無効なURL')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. search() — HTMLパーステスト
// ═══════════════════════════════════════════════════════════════════════════════

describe('search', () => {
  beforeEach(() => {
    mockFetch.mockClear()
  })

  test('正常: 3件の結果を正しくパース', async () => {
    const html = makeDDGHtml([
      { title: 'Title 1', url: 'https://example1.com', snippet: 'Snippet 1' },
      { title: 'Title 2', url: 'https://example2.com', snippet: 'Snippet 2' },
      { title: 'Title 3', url: 'https://example3.com', snippet: 'Snippet 3' },
    ])
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(html) } as any)

    const results = await search('test', 5)

    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ title: 'Title 1', url: 'https://example1.com', snippet: 'Snippet 1' })
    expect(results[1]!.url).toBe('https://example2.com')
    expect(results[2]!.title).toBe('Title 3')
  })

  test('uddg URL デコード: エンコードされたURLを正しく復元', async () => {
    const html = makeDDGHtml([
      { title: 'Encoded', url: 'https://example.com/path?q=hello world', snippet: '' },
    ])
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(html) } as any)

    const results = await search('test', 5)
    expect(results[0]!.url).toBe('https://example.com/path?q=hello world')
  })

  test('広告除外: .result--ad クラスをスキップ（リグレッション）', async () => {
    const html = makeDDGHtml([
      { title: 'Organic', url: 'https://organic.com', snippet: 'Real result' },
      { title: 'Ad Result', url: 'https://ad.com', snippet: 'Ad content', isAd: true },
      { title: 'Organic 2', url: 'https://organic2.com', snippet: 'Real result 2' },
    ])
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(html) } as any)

    const results = await search('test', 10)

    expect(results).toHaveLength(2)
    expect(results.every(r => r.url !== 'https://ad.com')).toBe(true)
  })

  test('limit: 広告除外後に指定件数でslice', async () => {
    const html = makeDDGHtml([
      { title: 'T1', url: 'https://e1.com', snippet: '' },
      { title: 'Ad', url: 'https://ad.com', snippet: '', isAd: true },
      { title: 'T2', url: 'https://e2.com', snippet: '' },
      { title: 'T3', url: 'https://e3.com', snippet: '' },
      { title: 'T4', url: 'https://e4.com', snippet: '' },
    ])
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(html) } as any)

    const results = await search('test', 2)
    expect(results).toHaveLength(2)
  })

  test('結果ゼロ: .result要素なし → 空配列', async () => {
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve('<html><body></body></html>') } as any)

    const results = await search('test', 5)
    expect(results).toHaveLength(0)
  })

  test('uddg なし: URLがnullになりフィルタされる', async () => {
    const html = `<html><body>
      <div class="result">
        <a class="result__a" href="/no-uddg">No uddg link</a>
        <div class="result__snippet">snippet</div>
      </div>
    </body></html>`
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(html) } as any)

    const results = await search('test', 5)
    expect(results).toHaveLength(0)
  })

  test('タイムアウト: AbortError → throw', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    mockFetch.mockRejectedValueOnce(abortError)

    await expect(search('test', 5)).rejects.toThrow()
  })

  test('ネットワークエラー: TypeError → throw', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(search('test', 5)).rejects.toThrow('Failed to fetch')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. fetchPage() — ユニットテスト + 異常系
// ═══════════════════════════════════════════════════════════════════════════════

describe('fetchPage', () => {
  beforeEach(() => {
    resetBrowser()
    mockLaunch.mockClear()
    mockNewPage.mockClear()
    mockClose.mockClear()
    mockGoto.mockImplementation(() => Promise.resolve({ ok: () => true, status: () => 200 } as any))
    mockContent.mockImplementation(() => Promise.resolve(ARTICLE_HTML))
  })

  afterEach(() => {
    resetBrowser()
  })

  test('正常: Readability抽出 → "# タイトル\\n\\n本文" 形式', async () => {
    const result = await fetchPage('https://example.com')

    expect(result).toMatch(/^# Test Article\n\n/)
    expect(result).toContain('This is the first paragraph')
  })

  test('テキスト整形: 連続空行が\\n\\nに圧縮される', async () => {
    const htmlWithBlanks = `<!DOCTYPE html>
<html><head><title>Blank Lines Test</title></head><body>
<article>
<p>First paragraph with substantial content to pass Readability threshold.</p>


<p>Second paragraph after multiple blank lines in the source HTML content here.</p>


<p>Third paragraph for additional content required by Readability parser.</p>
</article>
</body></html>`
    mockContent.mockImplementationOnce(() => Promise.resolve(htmlWithBlanks))

    const result = await fetchPage('https://example.com')

    expect(result).not.toMatch(/\n{3,}/)
  })

  test('HTTPエラー: response.ok() = false → throw', async () => {
    mockGoto.mockImplementationOnce(() =>
      Promise.resolve({ ok: () => false, status: () => 404 } as any),
    )

    await expect(fetchPage('https://example.com')).rejects.toThrow('HTTPエラー 404')
  })

  test('Readabilityエラー: parse()がnull → throw', async () => {
    // Readabilityはコンテンツが不十分な場合nullを返す
    mockContent.mockImplementationOnce(() =>
      Promise.resolve('<html><head><title>Empty</title></head><body></body></html>'),
    )

    await expect(fetchPage('https://example.com')).rejects.toThrow('ページを読み取れませんでした')
  })

  test('page.close(): 例外発生時もfinallyで必ず呼ばれる', async () => {
    mockClose.mockClear()
    mockGoto.mockImplementationOnce(() =>
      Promise.resolve({ ok: () => false, status: () => 500 } as any),
    )

    await expect(fetchPage('https://example.com')).rejects.toThrow()
    expect(mockClose).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 4. getBrowser() — ブラウザ管理テスト
// ═══════════════════════════════════════════════════════════════════════════════

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

  afterEach(() => {
    resetBrowser()
    _connected = true
  })

  test('初回: puppeteer.launch() が呼ばれる', async () => {
    await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(1)
  })

  test('2回目: キャッシュされたインスタンスを返す（launch は1回のみ）', async () => {
    const b1 = await getBrowser()
    const b2 = await getBrowser()

    expect(mockLaunch).toHaveBeenCalledTimes(1)
    expect(b1).toBe(b2)
  })

  test('再接続: browser.connected = false の場合 launch が再実行される（リグレッション）', async () => {
    await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(1)

    // ブラウザが切断状態をシミュレート
    _connected = false

    await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(2)
  })

  test('disconnected イベント: 発火後に getBrowser が再起動する', async () => {
    await getBrowser()
    expect(_disconnectedHandler).not.toBeNull()

    // disconnected イベントを発火
    _disconnectedHandler!()

    // 次の getBrowser で launch が再実行される
    mockLaunch.mockClear()
    await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(1)
  })

  test('並列呼び出し: launch は1回のみ（競合防止）', async () => {
    const [b1, b2, b3] = await Promise.all([getBrowser(), getBrowser(), getBrowser()])

    expect(mockLaunch).toHaveBeenCalledTimes(1)
    expect(b1).toBe(b2)
    expect(b2).toBe(b3)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 5. ファズ境界値テスト
// ═══════════════════════════════════════════════════════════════════════════════

describe('ファズ境界値テスト', () => {
  beforeEach(() => {
    mockFetch.mockClear()
    mockFetch.mockResolvedValue({ text: () => Promise.resolve('<html><body></body></html>') } as any)
  })

  test("query に SQLインジェクション風文字: \"' OR 1=1\"", async () => {
    const results = await search("' OR 1=1", 5)
    expect(Array.isArray(results)).toBe(true)
  })

  test('query に XSS風文字: "<script>alert(1)</script>"', async () => {
    const results = await search('<script>alert(1)</script>', 5)
    expect(Array.isArray(results)).toBe(true)
  })

  test('query に日本語マルチバイト文字', async () => {
    const results = await search('あいうえお', 5)
    expect(Array.isArray(results)).toBe(true)
  })

  test('query が空文字列: Zodは通す、結果ゼロ', async () => {
    const results = await search('', 5)
    expect(results).toHaveLength(0)
  })

  test('limit 境界: 1件', async () => {
    const html = makeDDGHtml([
      { title: 'T1', url: 'https://e1.com', snippet: '' },
      { title: 'T2', url: 'https://e2.com', snippet: '' },
    ])
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(html) } as any)

    const results = await search('test', 1)
    expect(results).toHaveLength(1)
  })

  test('limit 境界: 20件（全件取得）', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      title: `Title ${i}`,
      url: `https://example${i}.com`,
      snippet: '',
    }))
    const html = makeDDGHtml(items)
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(html) } as any)

    const results = await search('test', 20)
    expect(results).toHaveLength(20)
  })

  test('validateUrl: URLにUnicode文字が含まれる', () => {
    expect(() => validateUrl('https://example.com/path/あいう')).not.toThrow()
  })

  test('validateUrl: 非常に長いURL', () => {
    const longPath = 'a'.repeat(2000)
    expect(() => validateUrl(`https://example.com/${longPath}`)).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 6. validateUrl — 追加セキュリティテスト
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateUrl — 追加テスト', () => {
  test('http://LOCALHOST → hostnameが小文字に正規化されて拒否される（A-2）', () => {
    expect(() => validateUrl('http://LOCALHOST')).toThrow('プライベートIP')
  })

  test('http://127.1 → 短縮IPv4形式の動作確認（C-10）', () => {
    const hostname = new URL('http://127.1').hostname
    if (hostname === '127.0.0.1' || hostname.startsWith('127.')) {
      expect(() => validateUrl('http://127.1')).toThrow('プライベートIP')
    } else {
      // BunがIPを正規化しない場合、現在のチェックを通過する（動作をドキュメント化）
      expect(hostname).toBe('127.1')
    }
  })

  test('http://169.254.169.254 → 現在はチェックなし（A-3 動作ドキュメント）', () => {
    // AWSメタデータエンドポイント。クラウド環境では追加チェックが望ましい
    expect(() => validateUrl('http://169.254.169.254')).not.toThrow()
  })

  test('http://[::ffff:7f00:1] → IPv4-mapped IPv6は現在通過（A-4 動作ドキュメント）', () => {
    // ::ffff:127.0.0.1 のhex表現。現在のチェックではブロックされない
    expect(() => validateUrl('http://[::ffff:7f00:1]')).not.toThrow()
  })

  test('https://user:pass@example.com → hostnameのみチェック、認証情報は無視（C-2）', () => {
    expect(() => validateUrl('https://user:pass@example.com')).not.toThrow()
  })

  test('javascript:alert(1) → スキーム拒否（C-3）', () => {
    expect(() => validateUrl('javascript:alert(1)')).toThrow('許可されていないスキーム')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 7. getBrowser() — launch失敗テスト（A-1 バグ修正確認）
// ═══════════════════════════════════════════════════════════════════════════════

describe('getBrowser — launch失敗', () => {
  beforeEach(() => {
    resetBrowser()
    _connected = true
    _disconnectedHandler = null
    mockLaunch.mockClear()
  })

  afterEach(() => {
    resetBrowser()
    _connected = true
  })

  test('launch失敗後: 2回目は再度launchを試みる（A-1 バグ修正確認）', async () => {
    mockLaunch
      .mockRejectedValueOnce(new Error('launch failed'))
      .mockImplementationOnce(() => {
        _connected = true
        return Promise.resolve(mockBrowser as any)
      })

    await expect(getBrowser()).rejects.toThrow('launch failed')

    // バグ修正後: browserPromise が null にリセットされているので再試行できる
    const b = await getBrowser()
    expect(mockLaunch).toHaveBeenCalledTimes(2)
    expect(b).toBe(mockBrowser)
  })

  test('launch失敗: fetchPage全体がrejectされる（B-1）', async () => {
    mockLaunch.mockRejectedValueOnce(new Error('browser launch failed'))

    await expect(fetchPage('https://example.com')).rejects.toThrow('browser launch failed')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 8. fetchPage() — 追加異常系テスト
// ═══════════════════════════════════════════════════════════════════════════════

describe('fetchPage — 追加異常系', () => {
  beforeEach(() => {
    resetBrowser()
    _connected = true
    mockLaunch.mockClear()
    mockNewPage.mockClear()
    mockClose.mockClear()
    mockGoto.mockImplementation(() => Promise.resolve({ ok: () => true, status: () => 200 } as any))
    mockContent.mockImplementation(() => Promise.resolve(ARTICLE_HTML))
    mockLaunch.mockImplementation(() => {
      _connected = true
      return Promise.resolve(mockBrowser as any)
    })
  })

  afterEach(() => {
    resetBrowser()
    _connected = true
  })

  test('goto() がnullを返す → ok()チェックスキップ → 正常続行（B-5）', async () => {
    mockGoto.mockResolvedValueOnce(null)

    const result = await fetchPage('https://example.com')
    expect(result).toMatch(/^# Test Article/)
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  test('goto() がthrow → page.close() がfinallyで呼ばれる（B-6）', async () => {
    mockGoto.mockRejectedValueOnce(new Error('Navigation timeout'))

    await expect(fetchPage('https://example.com')).rejects.toThrow('Navigation timeout')
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  test('newPage() がthrow → fetchPageがrejectされる、page.close()は呼ばれない（B-7）', async () => {
    mockNewPage.mockRejectedValueOnce(new Error('newPage crash'))

    await expect(fetchPage('https://example.com')).rejects.toThrow('newPage crash')
    // page が未作成なので close() は呼ばれない
    expect(mockClose).toHaveBeenCalledTimes(0)
  })

  test('HTMLエンティティ: &amp; → & としてデコードされる（B-8）', async () => {
    const htmlWithEntities = `<!DOCTYPE html>
<html><head><title>Test &amp; Article</title></head><body><article>
<h1>Test &amp; Article</h1>
<p>Content with &amp; entity and substantial text for Readability to parse properly here.</p>
<p>Second paragraph with more content to ensure the parser functions correctly for testing.</p>
<p>Third paragraph for additional content required by Readability parser threshold here.</p>
</article></body></html>`
    mockContent.mockImplementationOnce(() => Promise.resolve(htmlWithEntities))

    const result = await fetchPage('https://example.com')
    expect(result).toContain('&')
    expect(result).not.toContain('&amp;')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 9. search() — 追加テスト
// ═══════════════════════════════════════════════════════════════════════════════

describe('search — 追加テスト', () => {
  beforeEach(() => {
    mockFetch.mockClear()
  })

  test('href属性がnull → URLがnullになりフィルタされる（B-2）', async () => {
    const html = `<html><body>
      <div class="result">
        <a class="result__a">No href attribute</a>
        <div class="result__snippet">snippet</div>
      </div>
    </body></html>`
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(html) } as any)

    const results = await search('test', 5)
    expect(results).toHaveLength(0)
  })

  test('スニペット要素なし → snippet: "" で返る（B-3）', async () => {
    const html = `<html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com')}">Title</a>
      </div>
    </body></html>`
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(html) } as any)

    const results = await search('test', 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.snippet).toBe('')
  })

  test('res.text() がreject → search全体がreject（B-4）', async () => {
    mockFetch.mockResolvedValueOnce({
      text: () => Promise.reject(new Error('text() failed')),
    } as any)

    await expect(search('test', 5)).rejects.toThrow('text() failed')
  })

  test('不正なhref URL → その要素はスキップ、他の結果は返る（B-9 バグ修正確認）', async () => {
    const html = `<html><body>
      <div class="result">
        <a class="result__a" href="//invalid url with spaces">Bad URL</a>
        <div class="result__snippet">bad</div>
      </div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://good.com')}">Good</a>
        <div class="result__snippet">good</div>
      </div>
    </body></html>`
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(html) } as any)

    const results = await search('test', 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.url).toBe('https://good.com')
  })

  test('タイトルが空文字 → title: "" で結果として返る（C-1）', async () => {
    const html = `<html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com')}"></a>
        <div class="result__snippet">snippet</div>
      </div>
    </body></html>`
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(html) } as any)

    const results = await search('test', 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.title).toBe('')
  })
})

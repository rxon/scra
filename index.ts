import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Readability } from '@mozilla/readability'
import { JSDOM, VirtualConsole } from 'jsdom'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import { z } from 'zod'

// ── Constants ────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TIMEOUT_SEARCH = 30_000
const TIMEOUT_FETCH = 20_000
const PRIVATE_IP_RE = /^172\.(1[6-9]|2\d|3[01])\./

// ── Browser singleton ────────────────────────────────────────────────────────

let browser: Browser | null = null
let browserPromise: Promise<Browser> | null = null

export async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser
  browser = null
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ headless: true })
      .then(b => {
        browser = b
        browserPromise = null
        b.on('disconnected', () => { browser = null })
        return b
      })
      .catch(e => { browserPromise = null; throw e })
  }
  return browserPromise
}

export function resetBrowser(): void {
  browser = null
  browserPromise = null
}

async function shutdown() {
  await browser?.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ── Utilities ────────────────────────────────────────────────────────────────

const text = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })
const errorText = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true as const })
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function validateUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`無効なURL: ${url}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`許可されていないスキーム: ${parsed.protocol}`)
  }
  const h = parsed.hostname
  if (
    h === 'localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    h === '0.0.0.0' ||
    h.startsWith('127.') ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    PRIVATE_IP_RE.test(h)
  ) {
    throw new Error(`プライベートIPへのアクセスは拒否されました: ${h}`)
  }
}

async function withPage<T>(timeout: number, fn: (page: Page) => Promise<T>): Promise<T> {
  const b = await getBrowser()
  const page = await b.newPage()
  try {
    page.setDefaultNavigationTimeout(timeout)
    await page.setUserAgent({ userAgent: UA })
    return await fn(page)
  } finally {
    await page.close()
  }
}

// ── Tools ────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'scra', version: '0.0.1' })

server.registerTool(
  'search',
  {
    description:
      'キーワードでDuckDuckGoを検索し、タイトル・URL・スニペットを番号付きで返す。' +
      '最大20件取得可能（デフォルト5件）。ページ本文が必要な場合は fetch ツールを使うこと。',
    inputSchema: {
      query: z.string().describe('検索クエリ'),
      limit: z.number().int().min(1).max(20).default(5).describe('取得件数（1〜20、デフォルト5）'),
    },
  },
  async ({ query, limit }) => {
    try {
      const results = await search(query, limit)
      if (results.length === 0) return text('検索結果が見つかりませんでした。')
      const lines = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
      )
      return text(lines.join('\n\n'))
    } catch (e) {
      return errorText(`search エラー: ${errMsg(e)}`)
    }
  },
)

server.registerTool(
  'fetch',
  {
    description:
      'URLを指定してページ本文をMarkdown形式（# タイトル + 本文）で返す。' +
      'JavaScriptが必要なSPAも取得可能。ローカルIP・file://へのアクセスは拒否される。' +
      '20秒でタイムアウト。',
    inputSchema: {
      url: z.string().url().describe('取得するページのURL（https:// または http://）'),
    },
  },
  async ({ url }) => {
    try {
      validateUrl(url)
      return text(await fetchPage(url))
    } catch (e) {
      return errorText(`fetch エラー: ${errMsg(e)}`)
    }
  },
)

// ── Implementations ──────────────────────────────────────────────────────────

export async function search(query: string, limit: number) {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  return withPage(TIMEOUT_SEARCH, async (page) => {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' })
    const dom = new JSDOM(await page.content(), { virtualConsole: new VirtualConsole() })
    return [...dom.window.document.querySelectorAll<HTMLElement>('.result')]
      .filter(el => !el.classList.contains('result--ad') && !!el.querySelector('.result__a'))
      .map(el => {
        const a = el.querySelector<HTMLAnchorElement>('.result__a')!
        const href = a.getAttribute('href')
        try {
          const uddg = href ? new URL('https:' + href).searchParams.get('uddg') : null
          const resolvedUrl = uddg ? decodeURIComponent(uddg) : null
          return {
            title: a.textContent?.trim() ?? '',
            url: resolvedUrl,
            snippet: el.querySelector('.result__snippet')?.textContent?.trim() ?? '',
          }
        } catch {
          return null
        }
      })
      .filter((r): r is { title: string; url: string; snippet: string } => r !== null && !!r.url)
      .slice(0, limit)
  })
}

export async function fetchPage(url: string) {
  return withPage(TIMEOUT_FETCH, async (page) => {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
    if (response && !response.ok()) {
      throw new Error(`HTTPエラー ${response.status()}: ${url}`)
    }
    const dom = new JSDOM(await page.content(), { url, virtualConsole: new VirtualConsole() })
    const article = new Readability(dom.window.document).parse()
    if (!article) throw new Error(`ページを読み取れませんでした: ${url}`)
    const body = (article.textContent ?? '')
      .split('\n')
      .map(l => l.trim())
      .filter((l, i, a) => l || (a[i - 1] !== ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return `# ${article.title}\n\n${body}`
  })
}

// ── Start ────────────────────────────────────────────────────────────────────

if (import.meta.main) await server.connect(new StdioServerTransport())

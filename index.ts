import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Readability } from '@mozilla/readability'
import { JSDOM, VirtualConsole } from 'jsdom'
import puppeteer, { type Browser } from 'puppeteer'
import { z } from 'zod'

// --- Browser singleton ---

let browser: Browser | null = null
async function getBrowser() {
  if (!browser) browser = await puppeteer.launch({ headless: true })
  return browser
}
process.on('SIGINT', async () => { await browser?.close(); process.exit(0) })
process.on('SIGTERM', async () => { await browser?.close(); process.exit(0) })

// --- Helpers ---

const text = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })
const errorText = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true as const })

function validateUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`無効なURL: ${url}`)
  }
  if (parsed.protocol === 'file:') throw new Error('file:// URLはアクセスできません')
  const hostname = parsed.hostname
  if (
    hostname === 'localhost' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  ) {
    throw new Error(`プライベートIPへのアクセスは拒否されました: ${hostname}`)
  }
}

// --- Tools ---

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
      return errorText(`search エラー: ${e instanceof Error ? e.message : String(e)}`)
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
      return errorText(`fetch エラー: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
)

// --- Implementations ---

async function search(query: string, limit: number) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(10_000),
  })
  const dom = new JSDOM(await res.text())
  const results = [...dom.window.document.querySelectorAll<HTMLElement>('.result')]
  return results
    .slice(0, limit)
    .map(el => {
      const a = el.querySelector<HTMLAnchorElement>('.result__a')
      const snippetEl = el.querySelector('.result__snippet')
      const href = a?.getAttribute('href')
      const resolvedUrl = href
        ? decodeURIComponent(new URL('https:' + href).searchParams.get('uddg') ?? href)
        : null
      return {
        title: a?.textContent?.trim() ?? '',
        url: resolvedUrl,
        snippet: snippetEl?.textContent?.trim() ?? '',
      }
    })
    .filter((r): r is { title: string; url: string; snippet: string } => !!r.url)
}

async function fetchPage(url: string) {
  const b = await getBrowser()
  const page = await b.newPage()
  try {
    page.setDefaultNavigationTimeout(20_000)
    await page.setUserAgent({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' })
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
    if (response && !response.ok()) {
      throw new Error(`HTTPエラー ${response.status()}: ${url}`)
    }
    const dom = new JSDOM(await page.content(), { url, virtualConsole: new VirtualConsole() })
    const article = new Readability(dom.window.document).parse()
    if (!article) throw new Error(`ページを読み取れませんでした: ${url}`)
    const body = (article.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
    return `# ${article.title}\n\n${body}`
  } finally {
    await page.close()
  }
}

// --- Start ---

await server.connect(new StdioServerTransport())

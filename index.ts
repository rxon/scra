import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Readability } from '@mozilla/readability'
import { JSDOM, VirtualConsole } from 'jsdom'
import puppeteer from 'puppeteer'
import { z } from 'zod'

// --- Tools ---

const server = new McpServer({ name: 'scra', version: '0.0.1' })

server.registerTool(
  'search',
  {
    description: 'キーワードでWeb検索してURL一覧を返す',
    inputSchema: { query: z.string() },
  },
  async ({ query }) => {
    const results = await search(query)
    return text(results.map(r => `${r.title}\n${r.url}`).join('\n\n'))
  },
)

server.registerTool(
  'fetch',
  {
    description: 'URLを指定してページ本文を返す',
    inputSchema: { url: z.string().url() },
  },
  async ({ url }) => text(await fetchPage(url)),
)

// --- Implementations ---

async function search(query: string) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
  })
  const dom = new JSDOM(await res.text())
  return [...dom.window.document.querySelectorAll<HTMLAnchorElement>('.result__a')]
    .map(a => {
      const href = a.getAttribute('href')
      const url = href ? decodeURIComponent(new URL('https:' + href).searchParams.get('uddg') ?? href) : null
      return { title: a.textContent?.trim() ?? '', url }
    })
    .filter((r): r is { title: string; url: string } => !!r.url)
}

async function fetchPage(url: string) {
  const browser = await puppeteer.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setUserAgent({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' })
    await page.goto(url, { waitUntil: 'networkidle2' })
    const dom = new JSDOM(await page.content(), { url, virtualConsole: new VirtualConsole() })
    const article = new Readability(dom.window.document).parse()
    if (!article) throw new Error(`ページを読み取れませんでした: ${url}`)
    const body = (article.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
    return `# ${article.title}\n\n${body}`
  } finally {
    await browser.close()
  }
}

// --- Helpers ---

const text = (content: string) => ({ content: [{ type: 'text' as const, text: content }] })

// --- Start ---

await server.connect(new StdioServerTransport())

import { test, expect, describe, afterAll } from 'bun:test'
import { search, fetchPage, validateUrl, getBrowser } from './index'

const skip = process.env.SKIP_INTEGRATION === '1'

// ═══════════════════════════════════════════════════════════════════════════════
// インテグレーションテスト（実DuckDuckGo + 実Puppeteer）
// ═══════════════════════════════════════════════════════════════════════════════

describe.if(!skip)('integration: search', () => {
  test(
    'TypeScript → limit=3 → 結果は0〜3件、各resultはtitle/url/snippetを持つ',
    async () => {
      const results = await search('TypeScript', 3)
      expect(results.length).toBeGreaterThanOrEqual(0)
      expect(results.length).toBeLessThanOrEqual(3)
      for (const r of results) {
        expect(typeof r.title).toBe('string')
        expect(r.title.length).toBeGreaterThan(0)
        expect(typeof r.url).toBe('string')
        expect(typeof r.snippet).toBe('string')
      }
    },
    { timeout: 30_000 },
  )

  test(
    'Bun runtime → limit=5 → 0〜5件',
    async () => {
      const results = await search('Bun runtime', 5)
      expect(results.length).toBeGreaterThanOrEqual(0)
      expect(results.length).toBeLessThanOrEqual(5)
    },
    { timeout: 30_000 },
  )

  test(
    'プログラミング → limit=3 → 配列が返る（日本語OK確認）',
    async () => {
      const results = await search('プログラミング', 3)
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeLessThanOrEqual(3)
    },
    { timeout: 30_000 },
  )

  test(
    'limit=1 → 結果 ≤ 1件',
    async () => {
      const results = await search('JavaScript', 1)
      expect(results.length).toBeLessThanOrEqual(1)
    },
    { timeout: 30_000 },
  )

  test(
    '各result.urlはvalidateUrl()を通過する',
    async () => {
      const results = await search('TypeScript tutorial', 5)
      for (const r of results) {
        expect(() => validateUrl(r.url)).not.toThrow()
      }
    },
    { timeout: 30_000 },
  )
})

describe.if(!skip)('integration: fetchPage', () => {
  afterAll(async () => {
    const b = await getBrowser().catch(() => null)
    await b?.close()
  })

  test(
    'https://example.com → "# " で始まる、3連続以上の改行なし',
    async () => {
      const result = await fetchPage('https://example.com')
      expect(result).toMatch(/^# .+/)
      expect(result).not.toMatch(/\n{3,}/)
    },
    { timeout: 30_000 },
  )

  test(
    'https://httpbin.org/status/404 → throwする',
    async () => {
      await expect(fetchPage('https://httpbin.org/status/404')).rejects.toThrow()
    },
    { timeout: 30_000 },
  )
})

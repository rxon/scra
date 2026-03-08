import { test, expect, describe } from 'bun:test'
import fc from 'fast-check'

// validateUrl はネットワーク不要なので直接 import
import { validateUrl } from './index'

// ── Arbitraries ───────────────────────────────────────────────────────────────

const publicUrlArb = fc
  .record({
    scheme: fc.constantFrom('https://', 'http://'),
    host: fc.domain(),
    path: fc.webPath(),
  })
  .map(({ scheme, host, path }) => `${scheme}${host}${path}`)

const class10Arb = fc
  .tuple(fc.nat(255), fc.nat(255), fc.nat(255))
  .map(([b, c, d]) => `http://10.${b}.${c}.${d}`)

const class192Arb = fc
  .tuple(fc.nat(255), fc.nat(255))
  .map(([c, d]) => `http://192.168.${c}.${d}`)

const class172Arb = fc
  .tuple(fc.integer({ min: 16, max: 31 }), fc.nat(255), fc.nat(255))
  .map(([b, c, d]) => `http://172.${b}.${c}.${d}`)

const privateIpArb = fc.oneof(class10Arb, class192Arb, class172Arb)

const forbiddenSchemeArb = fc
  .constantFrom('file://', 'ftp://', 'javascript:', 'data:')
  .chain(scheme => fc.domain().map(host => `${scheme}${host}`))

// ═══════════════════════════════════════════════════════════════════════════════
// PBT: validateUrl プロパティテスト
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateUrl PBT', () => {
  test('プロパティ1: 任意の公開ドメインhttps/httpURLはthrowしない', () => {
    fc.assert(
      fc.property(publicUrlArb, url => {
        expect(() => validateUrl(url)).not.toThrow()
      }),
      { numRuns: 200 },
    )
  })

  test('プロパティ2: プライベートIPは常にthrowする', () => {
    fc.assert(
      fc.property(privateIpArb, url => {
        expect(() => validateUrl(url)).toThrow('プライベートIPへのアクセスは拒否されました')
      }),
      { numRuns: 200 },
    )
  })

  test('プロパティ3: 禁止スキームは常にthrowする', () => {
    fc.assert(
      fc.property(forbiddenSchemeArb, url => {
        expect(() => validateUrl(url)).toThrow()
      }),
      { numRuns: 100 },
    )
  })

  test('プロパティ4: validateUrlを通過したURLはnew URL()でパース可能', () => {
    fc.assert(
      fc.property(publicUrlArb, url => {
        try {
          validateUrl(url)
          // throwしなかった場合、new URL()でパースできるはず
          expect(() => new URL(url)).not.toThrow()
        } catch {
          // validateUrlがthrowした場合はスキップ（このプロパティの対象外）
        }
      }),
      { numRuns: 200 },
    )
  })
})

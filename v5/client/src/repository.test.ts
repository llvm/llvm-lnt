import { describe, expect, it } from 'vitest'
import {
  commitLinkText,
  commitUrl,
  fillTemplate,
  rangeLinkText,
  rangeUrl,
  templateProblem,
  usableTemplate,
} from './repository'
import { NO_REPOSITORY, SUITE } from './test/fixtures'
import URL_TEMPLATES from './test/url-templates.json'

const GITHUB = SUITE.repository

describe('templateProblem', () => {
  // The cases the server's tests check its own rules against, so that the two agree.
  for (const key of ['commit_url', 'range_url'] as const) {
    it(`accepts and refuses the ${key} templates the server does`, () => {
      for (const template of URL_TEMPLATES[key].valid) {
        expect(templateProblem(key, template), template).toBeUndefined()
      }
      for (const template of URL_TEMPLATES[key].invalid) {
        expect(templateProblem(key, template), template).toBeDefined()
      }
    })
  }

  it('says why', () => {
    const problems = {
      'https://example.com/{commit} ': 'A URL cannot contain spaces or ASCII control characters.',
      'ftp://example.com/{commit}': 'A URL starts with http:// or https://.',
      'https://example.com/{sha}': '{sha} is not a placeholder this URL accepts, only {commit}.',
      'https://example.com/{{commit}}':
        'This URL cannot contain braces other than those of {commit}.',
      'https://example.com/': 'This URL must contain {commit}.',
      'https:///{commit}': 'A URL names a host after http:// or https://.',
      'https://github.com.{commit}/': 'A URL names its host as it is, without a placeholder.',
    }
    for (const [template, problem] of Object.entries(problems)) {
      expect(templateProblem('commit_url', template)).toBe(problem)
    }
    expect(templateProblem('range_url', 'https://example.com/{from}')).toBe(
      'This URL must contain {from} and {to}.',
    )
  })
})

describe('fillTemplate', () => {
  it('replaces each placeholder with its value', () => {
    expect(
      fillTemplate('https://example.com/{from}...{to}', {
        from: 'abc',
        to: 'def',
      }),
    ).toBe('https://example.com/abc...def')
    // Whichever comes first.
    expect(
      fillTemplate('https://example.com/{to}/{from}', {
        from: 'abc',
        to: 'def',
      }),
    ).toBe('https://example.com/def/abc')
  })

  it('replaces every occurrence of a placeholder', () => {
    expect(
      fillTemplate('https://example.com/c/{commit}?again={commit}#{commit}', {
        commit: 'a b',
      }),
    ).toBe('https://example.com/c/a%20b?again=a%20b#a%20b')
  })

  it("percent-encodes every character but an ASCII letter, a digit or one of -_.!~*'()", () => {
    const fill = (commit: string) => fillTemplate('https://example.com/{commit}', { commit })
    expect(fill("AZaz09-_.!~*'()")).toBe("https://example.com/AZaz09-_.!~*'()")
    expect(fill('a/b?c#d&e=f+g%h')).toBe('https://example.com/a%2Fb%3Fc%23d%26e%3Df%2Bg%25h')
    expect(fill(' :@;,"<>[]\\^`|')).toBe(
      'https://example.com/%20%3A%40%3B%2C%22%3C%3E%5B%5D%5C%5E%60%7C',
    )
    expect(fill('$&$1')).toBe('https://example.com/%24%26%241')
    // A value cannot add a placeholder of its own, since its braces are encoded.
    expect(fill('{commit}')).toBe('https://example.com/%7Bcommit%7D')
    // Each byte of the character's UTF-8 encoding.
    expect(fill('é')).toBe('https://example.com/%C3%A9')
    expect(fill('€')).toBe('https://example.com/%E2%82%AC')
    expect(fill('😀')).toBe('https://example.com/%F0%9F%98%80')
  })
})

describe('commitUrl and rangeUrl', () => {
  it('fill in the suite’s templates', () => {
    expect(commitUrl(GITHUB, '014621ede7c1')).toBe(
      'https://github.com/llvm/llvm-project/commit/014621ede7c1',
    )
    expect(rangeUrl(GITHUB, '0f985af790f8', '014621ede7c1')).toBe(
      'https://github.com/llvm/llvm-project/compare/0f985af790f8...014621ede7c1',
    )
  })

  it('are null when the suite has no template', () => {
    expect(commitUrl(NO_REPOSITORY, 'abc')).toBeNull()
    expect(rangeUrl(NO_REPOSITORY, 'abc', 'def')).toBeNull()
    expect(usableTemplate(NO_REPOSITORY, 'range_url')).toBeNull()
  })

  // Should the server have stored one anyway: the cases it refuses as well.
  for (const key of ['commit_url', 'range_url'] as const) {
    it(`are null for every ${key} that D4 refuses`, () => {
      for (const template of URL_TEMPLATES[key].invalid) {
        const repository = { ...NO_REPOSITORY, [key]: template }
        const url =
          key === 'commit_url' ? commitUrl(repository, 'abc') : rangeUrl(repository, 'abc', 'def')
        expect(url, template).toBeNull()
        expect(usableTemplate(repository, key), template).toBeNull()
      }
    })
  }
})

describe('commitLinkText and rangeLinkText', () => {
  it('name the repository by its label', () => {
    expect(commitLinkText(GITHUB)).toBe('View on GitHub')
    expect(rangeLinkText(GITHUB)).toBe('View changes on GitHub')
  })

  it('name it generically without one', () => {
    expect(commitLinkText(NO_REPOSITORY)).toBe('View in repository')
    expect(rangeLinkText(NO_REPOSITORY)).toBe('View changes in repository')
  })
})

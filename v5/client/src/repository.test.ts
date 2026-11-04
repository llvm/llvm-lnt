import { describe, expect, it } from 'vitest'
import {
  commitLinkText,
  repositoryLinkText,
  commitUrl,
  fillTemplate,
  rangeUrl,
  templateFieldProblem,
  templateProblem,
  usableTemplate,
  type LinkedCommit,
} from './repository'
import { commit, NO_REPOSITORY, SUITE } from './test/fixtures'
import URL_TEMPLATES from './test/url-templates.json'

const GITHUB = SUITE.repository
const { commit_fields: FIELDS } = URL_TEMPLATES

/** A commit with the commit string `value`, and these values for its fields. */
function linked(value: string, fields: LinkedCommit['fields'] = {}): LinkedCommit {
  return { value, fields }
}

/** `SUITE`, with these keys of its repository set, and none of the others. */
function withRepository(repository: Partial<typeof NO_REPOSITORY>) {
  return { ...SUITE, repository: { ...NO_REPOSITORY, ...repository } }
}

describe('templateProblem', () => {
  // The cases the server's tests check its own rules against, so that the two agree.
  for (const key of ['commit_url', 'range_url'] as const) {
    it(`accepts and refuses the ${key} templates the server does`, () => {
      for (const template of URL_TEMPLATES[key].valid) {
        expect(templateProblem(key, template, FIELDS), template).toBeUndefined()
      }
      for (const template of URL_TEMPLATES[key].invalid) {
        expect(templateProblem(key, template, FIELDS), template).toBeDefined()
      }
    })
  }

  it('says why', () => {
    const problems = {
      'https://example.com/{commit} ': 'A URL cannot contain spaces or ASCII control characters.',
      'ftp://example.com/{commit}': 'A URL starts with http:// or https://.',
      'https://example.com/{sha}':
        '{sha} is not a placeholder this URL accepts, only {commit} and {commit.<field>}.',
      'https://example.com/{from.git_sha}':
        '{from.git_sha} is not a placeholder this URL accepts, only {commit} and {commit.<field>}.',
      'https://example.com/{{commit}}':
        'This URL cannot contain braces other than those of its placeholders.',
      'https://example.com/': 'This URL must contain {commit} or {commit.<field>}.',
      'https:///{commit}': 'A URL names a host after http:// or https://.',
      'https://github.com.{commit}/': 'A URL names its host as it is, without a placeholder.',
      'https://example.com/{commit.author}': 'This URL names author, which is not a commit field.',
      'https://example.com/{commit.svn_revision}':
        'This URL names svn_revision, which is not a text field.',
    }
    for (const [template, problem] of Object.entries(problems)) {
      expect(templateProblem('commit_url', template, FIELDS)).toBe(problem)
    }
    expect(templateProblem('range_url', 'https://example.com/{from}', FIELDS)).toBe(
      'This URL must contain {from} or {from.<field>}, and {to} or {to.<field>}.',
    )
    expect(templateProblem('range_url', 'https://example.com/{sha}', FIELDS)).toBe(
      '{sha} is not a placeholder this URL accepts, only {from}, {to}, {from.<field>} and ' +
        '{to.<field>}.',
    )
  })
})

describe('templateFieldProblem', () => {
  it('checks the fields a template names, whatever else it holds', () => {
    expect(templateFieldProblem('{commit.git_sha} {sha} {', FIELDS)).toBeUndefined()
    expect(templateFieldProblem('ftp://{to.author}', FIELDS)).toBe(
      'This URL names author, which is not a commit field.',
    )
    // What does not look like a field's placeholder names no field.
    expect(templateFieldProblem('{commit.} {.author} {commit.a-b}', FIELDS)).toBeUndefined()
  })
})

describe('fillTemplate', () => {
  it('replaces each placeholder with its value', () => {
    const commits = { from: linked('abc'), to: linked('def') }
    expect(fillTemplate('https://example.com/{from}...{to}', commits)).toBe(
      'https://example.com/abc...def',
    )
    // Whichever comes first.
    expect(fillTemplate('https://example.com/{to}/{from}', commits)).toBe(
      'https://example.com/def/abc',
    )
  })

  it('replaces every occurrence of a placeholder', () => {
    const template = 'https://example.com/c/{commit}?again={commit}#{commit}'
    expect(fillTemplate(template, { commit: linked('a b') })).toBe(
      'https://example.com/c/a%20b?again=a%20b#a%20b',
    )
  })

  it("percent-encodes every character but an ASCII letter, a digit or one of -_.!~*'()", () => {
    const fill = (value: string) =>
      fillTemplate('https://example.com/{commit}', { commit: linked(value) })
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

  it('replaces a field’s placeholder with its commit’s value for it, percent-encoded', () => {
    const commits = {
      from: linked('r1', { git_sha: 'a/b' }),
      to: linked('r2', { git_sha: 'c d' }),
    }
    expect(fillTemplate('https://example.com/{from.git_sha}...{to.git_sha}', commits)).toBe(
      'https://example.com/a%2Fb...c%20d',
    )
    expect(fillTemplate('https://example.com/{from}/{to.git_sha}/{to}', commits)).toBe(
      'https://example.com/r1/c%20d/r2',
    )
  })

  it('gives the first field’s placeholder that its commit cannot fill in instead', () => {
    const template = 'https://example.com/{from.git_sha}./{to.git_sha}'
    const to = linked('r2', { git_sha: 'def' })
    for (const value of [null, undefined, '', '.', '..']) {
      const from = linked('r1', value === undefined ? {} : { git_sha: value })
      expect(fillTemplate(template, { from, to }), String(value)).toEqual({
        commit: 'from',
        field: 'git_sha',
      })
    }
    // Dots among other characters, or more than two, are a value like any other.
    const from = linked('r1', { git_sha: '...' })
    expect(fillTemplate(template, { from, to })).toBe('https://example.com/..../def')
  })
})

describe('commitUrl and rangeUrl', () => {
  it('fill in the suite’s templates', () => {
    expect(commitUrl(SUITE, linked('014621ede7c1'))).toBe(
      'https://github.com/llvm/llvm-project/commit/014621ede7c1',
    )
    expect(rangeUrl(SUITE, linked('0f985af790f8'), linked('014621ede7c1'))).toBe(
      'https://github.com/llvm/llvm-project/compare/0f985af790f8...014621ede7c1',
    )
  })

  it('fill them in with the commits’ values for the fields they name', () => {
    const suite = withRepository({
      commit_url: 'https://example.com/r{commit.svn_revision}',
      range_url: 'https://example.com/r{from.svn_revision}:r{to.svn_revision}',
    })
    const from = commit('a', { fields: { svn_revision: '100', commit_info: null } })
    const to = commit('b', { fields: { svn_revision: '200', commit_info: null } })
    expect(commitUrl(suite, to)).toBe('https://example.com/r200')
    expect(rangeUrl(suite, from, to)).toBe('https://example.com/r100:r200')
    // But not with a commit that has no value for one.
    expect(commitUrl(suite, commit('c'))).toBeNull()
    expect(rangeUrl(suite, from, commit('c'))).toBeNull()
  })

  it('are null when the suite has no template', () => {
    const suite = withRepository({})
    expect(commitUrl(suite, linked('abc'))).toBeNull()
    expect(rangeUrl(suite, linked('abc'), linked('def'))).toBeNull()
    expect(usableTemplate(suite, 'range_url')).toBeNull()
  })

  // Should the server have stored one anyway: the cases it refuses as well.
  for (const key of ['commit_url', 'range_url'] as const) {
    it(`are null for every ${key} that D4 refuses`, () => {
      for (const template of URL_TEMPLATES[key].invalid) {
        const suite = { ...withRepository({ [key]: template }), commit_fields: FIELDS }
        const fields = { git_sha: 'abc', svn_revision: 1 }
        const url =
          key === 'commit_url'
            ? commitUrl(suite, linked('abc', fields))
            : rangeUrl(suite, linked('abc', fields), linked('def', fields))
        expect(url, template).toBeNull()
        expect(usableTemplate(suite, key), template).toBeNull()
      }
    })
  }
})

describe('repositoryLinkText and commitLinkText', () => {
  it('name the repository by its label', () => {
    expect(repositoryLinkText(GITHUB, 'Diff')).toBe('Diff on GitHub')
    expect(commitLinkText(GITHUB)).toBe('View on GitHub')
  })

  it('name it generically without one', () => {
    expect(repositoryLinkText(NO_REPOSITORY, 'Diff')).toBe('Diff in repository')
    expect(commitLinkText(NO_REPOSITORY)).toBe('View in repository')
  })
})

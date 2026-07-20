import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

type OpenApiOperation = {
  responses: Record<string, unknown>
}

type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>
}

const openapiPath = path.join(process.cwd(), 'openapi.json')

function parseOpenApi(): OpenApiDocument {
  return JSON.parse(fs.readFileSync(openapiPath, 'utf8')) as OpenApiDocument
}

function findDuplicateObjectKeys(source: string): string[] {
  let offset = 0
  const duplicates: string[] = []

  function skipWhitespace(): void {
    while (/\s/.test(source[offset] ?? '')) offset += 1
  }

  function parseString(): string {
    const start = offset
    offset += 1
    while (offset < source.length) {
      if (source[offset] === '\\') {
        offset += 2
        continue
      }
      if (source[offset] === '"') {
        offset += 1
        return JSON.parse(source.slice(start, offset)) as string
      }
      offset += 1
    }
    throw new Error('Unterminated JSON string')
  }

  function parseValue(currentPath: string[]): void {
    skipWhitespace()
    const token = source[offset]
    if (token === '{') {
      parseObject(currentPath)
      return
    }
    if (token === '[') {
      offset += 1
      skipWhitespace()
      while (source[offset] !== ']') {
        parseValue(currentPath)
        skipWhitespace()
        if (source[offset] === ',') {
          offset += 1
          skipWhitespace()
        } else {
          break
        }
      }
      if (source[offset] !== ']') throw new Error('Malformed JSON array')
      offset += 1
      return
    }
    if (token === '"') {
      parseString()
      return
    }
    while (offset < source.length && !/[\s,}\]]/.test(source[offset])) offset += 1
  }

  function parseObject(currentPath: string[]): void {
    offset += 1
    skipWhitespace()
    const keys = new Set<string>()
    while (source[offset] !== '}') {
      if (source[offset] !== '"') throw new Error('Malformed JSON object key')
      const key = parseString()
      if (keys.has(key)) duplicates.push([...currentPath, key].join('.'))
      keys.add(key)
      skipWhitespace()
      if (source[offset] !== ':') throw new Error('Malformed JSON object')
      offset += 1
      parseValue([...currentPath, key])
      skipWhitespace()
      if (source[offset] === ',') {
        offset += 1
        skipWhitespace()
      } else {
        break
      }
    }
    if (source[offset] !== '}') throw new Error('Malformed JSON object')
    offset += 1
  }

  parseValue([])
  skipWhitespace()
  if (offset !== source.length) throw new Error('Unexpected JSON content')
  return duplicates
}

function responseKeys(document: OpenApiDocument, apiPath: string, method: string): string[] {
  return Object.keys(document.paths[apiPath][method].responses).sort()
}

describe('OpenAPI Agent Studio response contracts', () => {
  it('keeps the exact Agent Studio response sets documented', () => {
    const document = parseOpenApi()

    expect(responseKeys(document, '/api/studio/agents', 'post')).toEqual([
      '201',
      '400',
      '401',
      '403',
      '409',
      '429',
      '500',
      '503',
    ])
    expect(responseKeys(document, '/api/studio/agents/{id}', 'delete')).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '429',
      '500',
    ])
    expect(responseKeys(document, '/api/studio/teams', 'post')).toEqual([
      '201',
      '400',
      '401',
      '403',
      '409',
      '429',
      '500',
    ])
    expect(responseKeys(document, '/api/studio/teams/{id}', 'delete')).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '429',
      '500',
    ])
    expect(responseKeys(document, '/api/studio/workflows', 'post')).toEqual([
      '201',
      '400',
      '401',
      '403',
      '409',
      '429',
      '500',
    ])
    expect(responseKeys(document, '/api/studio/workflows/{id}', 'delete')).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '429',
      '500',
    ])
    expect(responseKeys(document, '/api/studio/runtimes', 'get')).toEqual([
      '200',
      '401',
      '500',
      '503',
    ])
  })

  it('rejects duplicate JSON object keys before JSON.parse can hide them', () => {
    const source = fs.readFileSync(openapiPath, 'utf8')
    expect(findDuplicateObjectKeys(source)).toEqual([])
  })
})

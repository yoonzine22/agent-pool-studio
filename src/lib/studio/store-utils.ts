import { z } from 'zod'

export function toIsoDate(epochSeconds: number | null): string | null {
  return epochSeconds === null ? null : new Date(epochSeconds * 1_000).toISOString()
}

export function parseJson<T>(value: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(value))
}

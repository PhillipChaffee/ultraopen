/**
 * A minimal JSON Schema validator.
 *
 * LOAD-BEARING, not defence in depth. Auto-compaction silently strips `format` from the user
 * message it inserts, and the host's StructuredOutputError branch is itself gated on the format
 * being present — so a stripped run comes back as plain text with no error at all. Re-validating
 * locally is what turns that into a retry instead of handing the script a string where its schema
 * promised an object.
 *
 * Supports the subset that matters for agent output: type, required, properties, items, enum,
 * additionalProperties, and the numeric/string bounds. Anything it does not understand is treated
 * as satisfied — a validator that rejects valid data would be worse than one that misses an edge.
 */

export type ValidationResult = { valid: true } | { valid: false; errors: string[] }

export function validate(value: unknown, schema: Record<string, unknown>): ValidationResult {
  const errors: string[] = []
  check(value, schema, "", errors)
  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

function check(value: unknown, schema: Record<string, unknown>, path: string, errors: string[]): void {
  const where = path === "" ? "value" : path

  const enumValues = schema["enum"]
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => deepEqual(candidate, value))) {
    errors.push(`${where} must be one of ${JSON.stringify(enumValues)}`)
    return
  }

  const type = schema["type"]
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push(`${where} must be a ${type}, got ${describe(value)}`)
    return
  }
  // A union of types: satisfied if any member matches.
  if (Array.isArray(type) && !type.some((entry) => typeof entry === "string" && matchesType(value, entry))) {
    errors.push(`${where} must be one of ${type.join(" | ")}, got ${describe(value)}`)
    return
  }

  if (isPlainObject(value)) checkObject(value, schema, path, errors)
  if (Array.isArray(value)) checkArray(value, schema, path, errors)
  if (typeof value === "number") checkNumber(value, schema, where, errors)
  if (typeof value === "string") checkString(value, schema, where, errors)
}

function checkObject(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const required = schema["required"]
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) {
        errors.push(`${path === "" ? "value" : path} is missing required property "${key}"`)
      }
    }
  }

  const properties = schema["properties"]
  if (isPlainObject(properties)) {
    for (const [key, sub] of Object.entries(properties)) {
      if (!(key in value) || !isPlainObject(sub)) continue
      check(value[key], sub, path === "" ? key : `${path}.${key}`, errors)
    }

    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path === "" ? "value" : path} has unexpected property "${key}"`)
      }
    }
  }
}

function checkArray(value: unknown[], schema: Record<string, unknown>, path: string, errors: string[]): void {
  const items = schema["items"]
  if (isPlainObject(items)) {
    value.forEach((entry, index) => {
      check(entry, items, `${path === "" ? "" : path}[${index}]`, errors)
    })
  }

  const minItems = schema["minItems"]
  if (typeof minItems === "number" && value.length < minItems) {
    errors.push(`${path === "" ? "value" : path} must have at least ${minItems} item(s), got ${value.length}`)
  }
}

function checkNumber(value: number, schema: Record<string, unknown>, where: string, errors: string[]): void {
  const minimum = schema["minimum"]
  if (typeof minimum === "number" && value < minimum) errors.push(`${where} must be >= ${minimum}`)
  const maximum = schema["maximum"]
  if (typeof maximum === "number" && value > maximum) errors.push(`${where} must be <= ${maximum}`)
}

function checkString(value: string, schema: Record<string, unknown>, where: string, errors: string[]): void {
  const minLength = schema["minLength"]
  if (typeof minLength === "number" && value.length < minLength) {
    errors.push(`${where} must be at least ${minLength} character(s)`)
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value)
    case "array":
      return Array.isArray(value)
    case "string":
      return typeof value === "string"
    // JSON Schema's "integer" is a number constraint, not a distinct JS type.
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    default:
      // An unrecognised type keyword is treated as satisfied rather than rejected.
      return true
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]))
  }
  return false
}

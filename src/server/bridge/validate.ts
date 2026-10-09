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

/**
 * Finds provable self-contradictions — schema shapes NO value can ever satisfy — so a caller can
 * reject them before a subagent is ever spawned on them. A never-satisfiable schema cannot be
 * repaired by retrying: the ladder would burn real tokens to prove a theorem and record a null
 * that reads as the agent's failure, when the schema is the bug.
 *
 * Deliberately conservative. General satisfiability is undecidable, so only airtight shapes are
 * flagged, and any keyword this walk does not model (`$ref`, `patternProperties`,
 * `unevaluatedProperties`, the applicators and name constraints in UNMODELLED_APPLICATORS)
 * silences the checks it could invalidate — a validator that rejects satisfiable schemas would
 * be worse than one that misses a contradiction. A shape is provable only when every
 * admissible instance is forced into the constrained type: a pinned `type`, or — on fully
 * modelled nodes only — an `enum` whose members all share it; a schema a string can escape is
 * not provably unsatisfiable. Descent follows only subschemas that MUST hold: a required
 * property's subschema, and `items` when `minItems` forces at least one member.
 */
export function findContradictions(schema: Record<string, unknown>): string[] {
  const contradictions: string[] = []
  // A malformed schema (a sandbox script can pass anything) is not a provable contradiction;
  // the validator's doctrine is to treat what it does not understand as satisfied, and the
  // spawn layer already treats a falsy schema as absent.
  if (isPlainObject(schema)) {
    walkSchema(schema, "", new WeakSet(), contradictions)
  }
  return contradictions
}

/**
 * Keywords that apply other schemas, or constrain names, in ways this walk does not model.
 * A node carrying any of them keeps its PINNED-type checks (every instance still has the
 * pinned type — the other keywords can only restrict further), but loses its weaker
 * enum-derived checks and its descent, so nothing outside the model can turn a flag into a
 * false rejection.
 */
const UNMODELLED_APPLICATORS = [
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "const",
  "propertyNames",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
]

function walkSchema(
  schema: Record<string, unknown>,
  path: string,
  visited: WeakSet<object>,
  contradictions: string[],
): void {
  // A reused subschema object (or a self-referencing one) must not be walked twice.
  if (visited.has(schema)) {return}
  visited.add(schema)

  // Keywords outside the modelled subset could change what the node's keywords apply to;
  // silence rather than risk rejecting a satisfiable schema.
  if (schema["$ref"] !== undefined || schema["patternProperties"] !== undefined || schema["unevaluatedProperties"] !== undefined) {return}

  const {type} = schema,
   {enum: enumValues} = schema,
   // A keyword only constrains instances of its own type, so a contradiction is provable only
   // when EVERY admissible instance has that type. A pinned `type` proves it on its own — the
   // remaining keywords can only restrict further. An `enum` proves it only while it is the
   // whole candidate set, so it is honored solely on nodes the walk fully models.
   pinned = (jsonType: string): boolean =>
     (typeof type === "string" && type === jsonType) ||
     (Array.isArray(type) && type.length > 0 && type.every((entry) => entry === jsonType)),
   enumForced = (jsonType: string): boolean =>
     !UNMODELLED_APPLICATORS.some((keyword) => schema[keyword] !== undefined) &&
     Array.isArray(enumValues) && enumValues.length > 0 && enumValues.every((member) => matchesType(member, jsonType)),
   forced = (jsonType: string): boolean => pinned(jsonType) || enumForced(jsonType),
   at = path === "" ? "" : `at ${path}: `

  if (forced("object") && schema["additionalProperties"] === false) {
    const {required} = schema
    if (Array.isArray(required)) {
      const {properties} = schema,
       allowed = isPlainObject(properties) ? properties : {}
      for (const key of required) {
        if (typeof key === "string" && !Object.hasOwn(allowed, key)) {
          contradictions.push(`${at}required property "${key}" is ruled out by additionalProperties: false`)
        }
      }
    }
  }

  if (forced("number") || forced("integer")) {
    const {minimum} = schema,
     {maximum} = schema
    if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) {
      contradictions.push(`${at}minimum ${minimum} is above maximum ${maximum} — no number can satisfy both`)
    }
  }

  // Descend only where the subschema MUST hold: a required property applies to every object
  // instance, and items applies to every member of a non-empty array. A contradiction an
  // instance shape can dodge (an optional property, items of a possibly-empty array) must not
  // be flagged — rejecting a satisfiable schema is the worse error.
  if (forced("object")) {
    const {required} = schema,
     {properties} = schema
    if (Array.isArray(required) && isPlainObject(properties)) {
      for (const key of required) {
        if (typeof key !== "string") {continue}
        const sub = properties[key]
        if (isPlainObject(sub)) {
          walkSchema(sub, path === "" ? `properties.${key}` : `${path}.properties.${key}`, visited, contradictions)
        }
      }
    }
  }

  const {minItems} = schema
  if (forced("array") && typeof minItems === "number" && minItems >= 1) {
    const {items} = schema
    if (isPlainObject(items)) {
      walkSchema(items, path === "" ? "items" : `${path}.items`, visited, contradictions)
    }
  }
}

function check(value: unknown, schema: Record<string, unknown>, path: string, errors: string[]): void {
  const where = path === "" ? "value" : path,

   enumValues = schema["enum"]
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => deepEqual(candidate, value))) {
    errors.push(`${where} must be one of ${JSON.stringify(enumValues)}`)
    return
  }

  const {type} = schema
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push(`${where} must be a ${type}, got ${describe(value)}`)
    return
  }
  // A union of types: satisfied if any member matches.
  if (Array.isArray(type) && !type.some((entry) => typeof entry === "string" && matchesType(value, entry))) {
    errors.push(`${where} must be one of ${type.join(" | ")}, got ${describe(value)}`)
    return
  }

  if (isPlainObject(value)) {checkObject(value, schema, path, errors)}
  if (Array.isArray(value)) {checkArray(value, schema, path, errors)}
  if (typeof value === "number") {checkNumber(value, schema, where, errors)}
  if (typeof value === "string") {checkString(value, schema, where, errors)}
}

function checkObject(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const {required} = schema
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) {
        errors.push(`${path === "" ? "value" : path} is missing required property "${key}"`)
      }
    }
  }

  const {properties} = schema
  if (isPlainObject(properties)) {
    for (const [key, sub] of Object.entries(properties)) {
      if (!(key in value) || !isPlainObject(sub)) {continue}
      check(value[key], sub, path === "" ? key : `${path}.${key}`, errors)
    }

    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {errors.push(`${path === "" ? "value" : path} has unexpected property "${key}"`)}
      }
    }
  }
}

function checkArray(value: unknown[], schema: Record<string, unknown>, path: string, errors: string[]): void {
  const {items} = schema
  if (isPlainObject(items)) {
    value.forEach((entry, index) => {
      check(entry, items, `${path === "" ? "" : path}[${index}]`, errors)
    })
  }

  const {minItems} = schema
  if (typeof minItems === "number" && value.length < minItems) {
    errors.push(`${path === "" ? "value" : path} must have at least ${minItems} item(s), got ${value.length}`)
  }
}

function checkNumber(value: number, schema: Record<string, unknown>, where: string, errors: string[]): void {
  const {minimum} = schema
  if (typeof minimum === "number" && value < minimum) {errors.push(`${where} must be >= ${minimum}`)}
  const {maximum} = schema
  if (typeof maximum === "number" && value > maximum) {errors.push(`${where} must be <= ${maximum}`)}
}

function checkString(value: string, schema: Record<string, unknown>, where: string, errors: string[]): void {
  const {minLength} = schema
  if (typeof minLength === "number" && value.length < minLength) {
    errors.push(`${where} must be at least ${minLength} character(s)`)
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object": {
      return isPlainObject(value)
    }
    case "array": {
      return Array.isArray(value)
    }
    case "string": {
      return typeof value === "string"
    }
    // JSON Schema's "integer" is a number constraint, not a distinct JS type.
    case "integer": {
      return typeof value === "number" && Number.isInteger(value)
    }
    case "number": {
      return typeof value === "number" && Number.isFinite(value)
    }
    case "boolean": {
      return typeof value === "boolean"
    }
    case "null": {
      return value === null
    }
    default: {
      // An unrecognised type keyword is treated as satisfied rather than rejected.
      return true
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) {return "null"}
  if (Array.isArray(value)) {return "array"}
  return typeof value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {return true}
  if (typeof a !== typeof b || a === null || b === null) {return false}
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]))
  }
  return false
}

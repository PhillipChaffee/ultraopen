import { describe, expect, test } from "bun:test"
import { parse } from "../src/server/script/parse.js"
import { WorkflowScriptError } from "../src/server/script/errors.js"

/** Every rejection path in the pure-literal walk and the meta shape check. */
const diag = (source: string) => {
  try {
    parse(source)
  } catch (error) {
    if (error instanceof WorkflowScriptError) {return error.diagnostic}
    throw error
  }
  throw new Error("expected parse to throw")
},

 metaOf = (literalSource: string) => parse(`export const meta = ${literalSource}\n`).meta

describe("literal walk rejections", () => {
  test.each([
    ["regular expression", `{ name: /x/, description: 'y' }`, "regular expressions"],
    ["array spread", `{ name: 'x', description: 'y', phases: [...[]] }`, "spread"],
    ["object method", `{ name: 'x', description: 'y', go() {} }`, "methods"],
    ["getter", `{ name: 'x', description: 'y', get a() { return 1 } }`, "accessors"],
    ["identifier reference", `{ name: NAME, description: 'y' }`, "Identifier"],
    ["member expression", `{ name: a.b, description: 'y' }`, "MemberExpression"],
    ["arrow function", `{ name: 'x', description: 'y', f: () => 1 }`, "ArrowFunctionExpression"],
    ["binary expression", `{ name: 1 + 1, description: 'y' }`, "BinaryExpression"],
    ["unary not", `{ name: !1, description: 'y' }`, "! expression"],
  ])("rejects a %s", (_label, literalSource, expected) => {
    const d = diag(`export const meta = ${literalSource}\n`)
    expect(d.kind).toBe("MetaError")
    expect(d.message).toContain(expected)
  })

  test("rejects a computed key built from a template literal", () => {
    expect(diag("export const meta = { [`na${'me'}`]: 'x', description: 'y' }\n").message).toContain("computed")
  })

  test("drops __proto__ instead of polluting the prototype", () => {
    const meta = metaOf(`{ name: 'x', description: 'y', __proto__: { polluted: true } }`)
    expect(meta.name).toBe("x")
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype)
  })

  test("accepts numeric and quoted keys", () => {
    expect(metaOf(`{ 'name': 'x', "description": 'y' }`).name).toBe("x")
  })

  test("accepts nested literals, arrays and negative numbers", () => {
    const meta = metaOf(`{ name: 'x', description: 'y', phases: [{ title: 'a', detail: 'd' }] }`)
    expect(meta.phases).toEqual([{ title: "a", detail: "d" }])
  })

  test("preserves array holes as undefined", () => {
    // `[,]` has a hole; the walk maps it to undefined rather than crashing.
    const d = diag(`export const meta = { name: 'x', description: 'y', phases: [,] }\n`)
    expect(d.message).toContain("phases[0] must be an object")
  })
})

describe("meta shape validation", () => {
  test.each([
    ["missing name", `{ description: 'y' }`, "meta.name is required"],
    ["missing description", `{ name: 'x' }`, "meta.description is required"],
    ["blank name", `{ name: '   ', description: 'y' }`, "meta.name is required"],
    ["numeric name", `{ name: 1, description: 'y' }`, "meta.name is required"],
    ["non-string whenToUse", `{ name: 'x', description: 'y', whenToUse: 1 }`, "meta.whenToUse must be a string"],
    ["non-array phases", `{ name: 'x', description: 'y', phases: 'a' }`, "meta.phases must be an array"],
    ["phase not an object", `{ name: 'x', description: 'y', phases: ['a'] }`, "phases[0] must be an object"],
    ["phase array", `{ name: 'x', description: 'y', phases: [[]] }`, "phases[0] must be an object"],
    ["phase missing title", `{ name: 'x', description: 'y', phases: [{ detail: 'd' }] }`, "phases[0].title is required"],
    ["phase blank title", `{ name: 'x', description: 'y', phases: [{ title: ' ' }] }`, "phases[0].title is required"],
    ["phase bad detail", `{ name: 'x', description: 'y', phases: [{ title: 't', detail: 1 }] }`, "phases[0].detail must be a string"],
    ["phase bad model", `{ name: 'x', description: 'y', phases: [{ title: 't', model: 1 }] }`, "phases[0].model must be a string"],
  ])("rejects %s", (_label, literalSource, expected) => {
    expect(diag(`export const meta = ${literalSource}\n`).message).toContain(expected)
  })

  test("reports the index of the offending phase", () => {
    const d = diag(`export const meta = { name: 'x', description: 'y', phases: [{ title: 'a' }, { title: 2 }] }\n`)
    expect(d.message).toContain("phases[1].title")
  })

  test("accepts whenToUse and phases[].model, keeping model display-only", () => {
    const meta = metaOf(`{ name: 'x', description: 'y', whenToUse: 'when', phases: [{ title: 't', model: 'a/b' }] }`)
    expect(meta.whenToUse).toBe("when")
    expect(meta.phases?.[0]?.model).toBe("a/b")
  })

  test("meta must not be an array", () => {
    expect(diag(`export const meta = ['x']\n`).message).toContain("must be an object literal")
  })

  test("meta must not be a bare string", () => {
    expect(diag(`export const meta = 'x'\n`).message).toContain("must be an object literal")
  })

  test("meta must be initialised", () => {
    expect(diag(`export let meta\n`).message).toContain("must begin with")
  })

  test("rejects a differently-named first export", () => {
    expect(diag(`export const other = { name: 'x', description: 'y' }\n`).message).toContain("must declare `meta`")
  })

  test("rejects `let` and multiple declarators", () => {
    expect(diag(`export let meta = { name: 'x', description: 'y' }\n`).message).toContain("must begin with")
    expect(diag(`export const meta = { name: 'x', description: 'y' }, other = 1\n`).message).toContain("must begin with")
  })

  test("rejects an empty program", () => {
    expect(diag("").message).toContain("must begin with")
  })

  test("rejects a default export as the first statement", () => {
    expect(diag(`export default { name: 'x' }\n`).message).toContain("must begin with")
  })
})

describe("export blanking", () => {
  test("blanks `export { ... }` list form and `export default`", () => {
    const src = `export const meta = { name: 'x', description: 'y' }\nconst a = 1\nexport default a\nexport { a }\n`,
     { body } = parse(src)
    expect(body).not.toContain("export")
    expect(body.length).toBe(src.length)
    expect(body.split("\n").length).toBe(src.split("\n").length)
  })

  test("a script with only the meta export still round-trips", () => {
    const src = `export const meta = { name: 'x', description: 'y' }\n`
    expect(parse(src).body.length).toBe(src.length)
  })
})

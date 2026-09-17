import { isJsonObject, type JsonObject } from '@openagent/contracts'

/** Claude Code drops MCP tools with root oneOf. Disjoint const branches have an equivalent conditional schema. */
export function claudeToolSchema(schema: JsonObject): JsonObject {
  if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2 || !schema.oneOf.every(isJsonObject)) return schema
  const variants = schema.oneOf
  const first = variants[0]!
  if (!isJsonObject(first.properties)) return schema
  const discriminator = Object.keys(first.properties).find(key => {
    const properties = variants.map(variant => isJsonObject(variant.properties) ? variant.properties[key] : undefined)
    return properties.every(property => isJsonObject(property) && Object.hasOwn(property, 'const')) &&
      new Set(properties.map(property => JSON.stringify((property as JsonObject).const))).size === variants.length &&
      variants.every(variant => Array.isArray(variant.required) && variant.required.includes(key))
  })
  if (!discriminator) return schema
  const { oneOf: _oneOf, ...root } = schema
  let conditional: JsonObject = variants.at(-1)!
  for (let index = variants.length - 2; index >= 0; index--) {
    const variant = variants[index]!
    const properties = variant.properties as JsonObject
    conditional = {
      if: { properties: { [discriminator]: properties[discriminator]! }, required: [discriminator] },
      // JSON Schema's then is data, never a callable promise method.
      // oxlint-disable-next-line unicorn/no-thenable
      then: variant, else: conditional
    }
  }
  return { ...root, ...conditional }
}

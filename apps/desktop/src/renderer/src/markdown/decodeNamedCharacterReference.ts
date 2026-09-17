import { characterEntities } from 'character-entities'

const entities = characterEntities as Record<string, string>

export function decodeNamedCharacterReference(value: string): string | false {
  return Object.hasOwn(entities, value) ? entities[value] : false
}

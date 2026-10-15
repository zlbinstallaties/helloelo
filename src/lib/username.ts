/*
 * A suggestion for the user name of a new account, made from the name. The planner may change it; the server
 * has the final say on what is allowed (3 to 40 characters: letters, digits, dot, dash, underscore).
 */
export function suggestUsername(name: string): string {
  const words = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._\-\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
  const joined = words.join('.').replace(/^[^a-z0-9]+/, '').slice(0, 40).replace(/[^a-z0-9]+$/, '')
  return joined.length >= 3 ? joined : ''
}

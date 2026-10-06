/*
 * Project ids are used in hostnames and container names. A published app is
 * served at <id>-live.<domain>, so no project id may itself end in "-live":
 * that hostname would be ambiguous.
 */

export const LIVE_SUFFIX = '-live'
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID.test(value) && !value.endsWith(LIVE_SUFFIX)
}

import { GatewayError } from './errors.ts'

/*
 * Validation of app-supplied Odoo domains and order clauses.
 *
 * - Only allowlisted fields of the model, no dotted paths (no traversal into
 *   other models).
 * - Only plain comparison operators; no child_of/parent_of/any.
 * - Values are primitives or short primitive lists.
 * - The domain must consist of complete expressions, so the company leaf the
 *   client prepends is always ANDed with the whole domain.
 */

const OPERATORS = new Set([
  '=', '!=', '>', '>=', '<', '<=',
  'in', 'not in',
  'like', 'not like', 'ilike', 'not ilike', '=like', '=ilike',
])
const LIST_OPERATORS = new Set(['in', 'not in'])
const MAX_DOMAIN_ITEMS = 50
const MAX_LIST_VALUES = 200
const MAX_STRING_LENGTH = 500
const ORDER_PATTERN = /^([a-z_][a-z0-9_]*)(?:\s+(asc|desc))?$/i

function bad(code: string, message: string): never {
  throw new GatewayError(400, code, message)
}

function isPrimitive(value: unknown) {
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= MAX_STRING_LENGTH
  return false
}

function checkLeaf(leaf: unknown[], allowed: ReadonlySet<string>, used: Set<string>) {
  if (leaf.length !== 3) bad('invalid_domain', 'domain leaf must be [field, operator, value]')
  const [field, operator, value] = leaf
  if (typeof field !== 'string' || !allowed.has(field)) {
    throw new GatewayError(403, 'field_not_allowed', `field not allowed in domain: ${String(field)}`)
  }
  if (typeof operator !== 'string' || !OPERATORS.has(operator)) {
    bad('invalid_domain', `operator not allowed: ${String(operator)}`)
  }
  if (LIST_OPERATORS.has(operator)) {
    if (!Array.isArray(value) || value.length > MAX_LIST_VALUES || !value.every(isPrimitive)) {
      bad('invalid_domain', `${operator} needs a list of at most ${MAX_LIST_VALUES} values`)
    }
  } else if (!isPrimitive(value)) {
    bad('invalid_domain', 'domain value must be a string, number, boolean or null')
  }
  used.add(field)
}

/** Returns the field names used by the domain (for logging, never values). */
export function validateDomain(domain: unknown, allowedFields: readonly string[]): string[] {
  if (domain === undefined) return []
  if (!Array.isArray(domain)) bad('invalid_domain', 'domain must be a list')
  if (domain.length > MAX_DOMAIN_ITEMS) bad('invalid_domain', `domain has more than ${MAX_DOMAIN_ITEMS} items`)
  const items: unknown[] = domain
  const allowed = new Set(allowedFields)
  const used = new Set<string>()
  let index = 0

  function expression(): void {
    if (index >= items.length) bad('invalid_domain', 'domain operator is missing an operand')
    const item = items[index++]
    if (item === '&' || item === '|') {
      expression()
      expression()
    } else if (item === '!') {
      expression()
    } else if (Array.isArray(item)) {
      checkLeaf(item, allowed, used)
    } else {
      bad('invalid_domain', 'domain items must be leaves or &, |, !')
    }
  }

  while (index < items.length) expression()
  return [...used]
}

/** Validates "field [asc|desc], ..." against the allowlist; returns it normalized. */
export function validateOrder(order: unknown, allowedFields: readonly string[]): string | undefined {
  if (order === undefined || order === null || order === '') return undefined
  if (typeof order !== 'string' || order.length > 200) bad('invalid_order', 'order must be a short string')
  const allowed = new Set(allowedFields)
  return order
    .split(',')
    .map((part) => {
      const match = ORDER_PATTERN.exec(part.trim())
      if (!match) bad('invalid_order', 'order must be "field [asc|desc], ..."')
      if (!allowed.has(match[1])) {
        throw new GatewayError(403, 'field_not_allowed', `field not allowed in order: ${match[1]}`)
      }
      return match[2] ? `${match[1]} ${match[2].toLowerCase()}` : match[1]
    })
    .join(', ')
}

/** Requested fields must be a subset of the allowlist; default is all of it. */
export function validateFields(fields: unknown, allowedFields: readonly string[]): string[] {
  if (fields === undefined) return [...allowedFields]
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > allowedFields.length) {
    bad('invalid_fields', 'fields must be a non-empty list')
  }
  const allowed = new Set(allowedFields)
  for (const field of fields) {
    if (typeof field !== 'string' || !allowed.has(field)) {
      throw new GatewayError(403, 'field_not_allowed', `field not allowed: ${String(field)}`)
    }
  }
  return [...new Set(fields as string[])]
}

import type { Facts } from './facts.ts'

/*
 * The facts of a schouw that are put ON THE CUSTOMER in Odoo (`res.partner`), so that the quotation engine (the
 * offerte-assistent) and the people who make quotes can use them later. This table is the contract between three
 * places that must agree, and a test checks that they do:
 *
 *   - the dashboard, which decides what to send (`toCustomerFacts`);
 *   - the gateway and the Odoo client, which accept only these keys, these types and these Odoo fields;
 *   - the Odoo module `odoo_addon/dig_schouw_facts`, which defines the fields.
 *
 * What is written, and how (the rules of the engine itself, which fills only what is empty):
 *  - only EMPTY fields are filled. A value that somebody typed, or that an earlier schouw put there, is never overwritten;
 *  - "ja" and "nee" are a selection, not a checkbox: a checkbox cannot tell "nee" from "not filled in";
 *  - nothing else of the customer is touched: not the name, the address, the e-mail or any other field.
 */

type Base = { key: string; field: string; label: string }

export type CustomerFactSpec =
  | (Base & { type: 'selection'; options: readonly string[] })
  | (Base & { type: 'integer' | 'float'; min: number; max: number })
  | (Base & { type: 'char' | 'text'; maxLength: number })
  | (Base & { type: 'date' })

export type CustomerFactValue = string | number

const YES_NO = ['ja', 'nee'] as const

export const CUSTOMER_FACTS: readonly CustomerFactSpec[] = [
  { key: 'schouw_datum', field: 'dig_schouw_datum', label: 'Datum schouw', type: 'date' },
  { key: 'gewenst_systeem', field: 'dig_schouw_gewenst_systeem', label: 'Gewenst systeem', type: 'selection', options: ['hybride', 'all-electric'] },
  { key: 'afgiftesysteem', field: 'dig_schouw_afgiftesysteem', label: 'Afgiftesysteem', type: 'selection', options: ['vloer', 'radiatoren', 'lt_radiatoren', 'mix'] },
  { key: 'isolatie', field: 'dig_schouw_isolatie', label: 'Isolatie', type: 'selection', options: ['goed', 'matig', 'slecht'] },
  { key: 'aantal_personen', field: 'dig_schouw_aantal_personen', label: 'Aantal personen', type: 'integer', min: 1, max: 20 },
  { key: 'ruimte_installatie', field: 'dig_schouw_ruimte_installatie', label: 'Ruimte voor de installatie', type: 'selection', options: ['weinig', 'voldoende'] },
  { key: 'boiler_opstelling', field: 'dig_schouw_boiler_opstelling', label: 'Opstelling boiler of buffer', type: 'selection', options: ['horizontaal', 'staand'] },
  { key: 'bouwjaar', field: 'dig_schouw_bouwjaar', label: 'Bouwjaar woning', type: 'integer', min: 1500, max: 2100 },
  { key: 'gasverbruik_m3_per_jaar', field: 'dig_schouw_gasverbruik', label: 'Jaarverbruik gas (m³)', type: 'float', min: 0, max: 100000 },
  { key: 'leidingroute', field: 'dig_schouw_leidingroute', label: 'Leidingroute', type: 'text', maxLength: 1000 },
  { key: 'leidinglengte_m', field: 'dig_schouw_leidinglengte', label: 'Geschatte leidinglengte (m)', type: 'float', min: 0, max: 1000 },
  { key: 'aansluiting', field: 'dig_schouw_aansluiting', label: 'Elektrische aansluiting', type: 'selection', options: ['1-fase', '3-fase'] },
  { key: 'ruimte_meterkast', field: 'dig_schouw_ruimte_meterkast', label: 'Voldoende ruimte in de meterkast', type: 'selection', options: YES_NO },
  { key: 'groep_vrij', field: 'dig_schouw_groep_vrij', label: 'Vrije groep in de groepenkast', type: 'selection', options: YES_NO },
  { key: 'asbest_vermoed', field: 'dig_schouw_asbest_vermoed', label: 'Vermoeden van asbest', type: 'selection', options: YES_NO },
  { key: 'graafwerk_door_klant', field: 'dig_schouw_graafwerk_door_klant', label: 'Graafwerk door de klant', type: 'selection', options: YES_NO },
  { key: 'stroom_door_klant', field: 'dig_schouw_stroom_door_klant', label: 'Stroomvoorziening door de klant', type: 'selection', options: YES_NO },
  { key: 'werkruimte_door_klant', field: 'dig_schouw_werkruimte_door_klant', label: 'Werkruimte door de klant vrij te maken', type: 'selection', options: YES_NO },
  { key: 'schouw_compleet', field: 'dig_schouw_compleet', label: 'Schouw compleet voor de werkvoorbereiding', type: 'selection', options: YES_NO },
]

export const CUSTOMER_FACT_FIELDS: readonly string[] = CUSTOMER_FACTS.map((spec) => spec.field)

const BY_KEY = new Map(CUSTOMER_FACTS.map((spec) => [spec.key, spec]))
const BY_FIELD = new Map(CUSTOMER_FACTS.map((spec) => [spec.field, spec]))
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function customerFactSpec(key: string): CustomerFactSpec | undefined {
  return BY_KEY.get(key)
}

export function customerFactSpecByField(field: string): CustomerFactSpec | undefined {
  return BY_FIELD.get(field)
}

function realDate(value: string) {
  const match = DATE.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

const hasControlCharacter = (value: string, allowNewline: boolean) =>
  [...value].some((char) => {
    const code = char.charCodeAt(0)
    return (code < 32 && !(allowNewline && (code === 10 || code === 13))) || code === 127
  })

/** The value as Odoo should get it, or null when it is not a valid value for this fact. */
export function checkCustomerFact(spec: CustomerFactSpec, value: unknown): CustomerFactValue | null {
  switch (spec.type) {
    case 'selection':
      return typeof value === 'string' && spec.options.includes(value) ? value : null
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max ? value : null
    case 'float':
      return typeof value === 'number' && Number.isFinite(value) && value >= spec.min && value <= spec.max ? value : null
    case 'char':
    case 'text': {
      if (typeof value !== 'string') return null
      const text = value.replace(/\r\n?/g, '\n').trim()
      return text.length >= 1 && text.length <= spec.maxLength && !hasControlCharacter(text, spec.type === 'text') ? text : null
    }
    case 'date':
      return typeof value === 'string' && realDate(value) ? value : null
  }
}

export type CustomerFactsCheck = { ok: true; facts: Record<string, CustomerFactValue> } | { ok: false; error: string }

/** What the gateway accepts: at least one fact, only the keys of the table, each with a valid value. Strict: one wrong value refuses all. */
export function validateCustomerFacts(input: unknown): CustomerFactsCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'facts must be an object' }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return { ok: false, error: 'facts must not be empty' }
  const facts: Record<string, CustomerFactValue> = {}
  for (const [key, value] of entries) {
    const spec = BY_KEY.get(key)
    if (!spec) return { ok: false, error: `unknown fact: ${key.slice(0, 40)}` }
    const checked = checkCustomerFact(spec, value)
    if (checked === null) return { ok: false, error: `invalid value for fact: ${key}` }
    facts[key] = checked
  }
  return { ok: true, facts }
}

/**
 * What the dashboard sends for a schouw: the facts of the document in the form of the table (yes and no as "ja" and "nee"),
 * and the date of the schouw. A fact with a value the table does not accept is left out and counted, never sent. Only a
 * schouw gives facts for the customer.
 */
export function toCustomerFacts(source: Facts, schouwDate: string): { facts: Record<string, CustomerFactValue>; skipped: string[] } {
  const facts: Record<string, CustomerFactValue> = {}
  const skipped: string[] = []
  if (source.form !== 'schouw') return { facts, skipped }
  for (const [key, raw] of Object.entries(source.facts)) {
    const spec = BY_KEY.get(key)
    if (!spec) continue
    const value = typeof raw === 'boolean' ? (raw ? 'ja' : 'nee') : raw
    const checked = checkCustomerFact(spec, value)
    if (checked === null) skipped.push(key)
    else facts[key] = checked
  }
  const date = checkCustomerFact(BY_KEY.get('schouw_datum') as CustomerFactSpec, schouwDate)
  if (date !== null && Object.keys(facts).length > 0) facts.schouw_datum = date
  return { facts, skipped }
}

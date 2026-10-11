import { allFields } from './forms.ts'
import type { FactDef, FieldDef, FormDef } from './forms.ts'
import type { CleanAnswer } from './submission.ts'

/*
 * The answers of a document that are useful outside the document, under the stable names of `fact` in `forms.ts`: what the
 * quotation engine (the offerte-assistent) can use later, and what belongs on the customer. No I/O: this only says WHAT the
 * facts are. Where they are kept in Odoo is decided somewhere else (see docs/formulieren-schouw-oplevering.md).
 *
 * Rules, so that a fact can be trusted:
 *  - Only what was answered is a fact. "Onbekend" and "niet van toepassing" are NOT facts: a fact is never a guess. A system
 *    that fills only empty fields (as the offerte-assistent does) leaves those fields empty, which is what is true.
 *  - Numbers are numbers (a comma is a decimal point); the unit is part of the key (`leidinglengte_m`).
 *  - A yes or no is true or false; "niet van toepassing" is left out.
 *  - Free text is kept as it was typed, trimmed.
 *  - What does not apply to the choices made (`showWhen`) is not an answer, so it is never a fact.
 */

export type FactValue = string | number | boolean

export type Facts = {
  /** The kind of record, so that a reader can recognise it. */
  schema: 'dig.facts/1'
  form: string
  formVersion: number
  facts: Record<string, FactValue>
}

const NEVER_A_FACT = new Set(['onbekend', 'nvt'])

function toFact(field: FieldDef, def: FactDef, answer: CleanAnswer): FactValue | null {
  switch (field.kind) {
    case 'text':
    case 'textarea':
      return typeof answer === 'string' && answer ? answer : null
    case 'date':
      return typeof answer === 'string' && answer ? answer : null
    case 'number': {
      if (typeof answer !== 'string') return null
      const value = Number(answer.replace(',', '.'))
      return Number.isFinite(value) ? value : null
    }
    case 'choice': {
      if (typeof answer !== 'string') return null
      if (def.values) {
        const mapped = Object.hasOwn(def.values, answer) ? def.values[answer] : null
        return mapped ?? null
      }
      return NEVER_A_FACT.has(answer) ? null : answer
    }
    case 'yesno': {
      if (typeof answer !== 'object' || Array.isArray(answer)) return null
      if (answer.value === 'ja') return true
      if (answer.value === 'nee') return false
      return null
    }
    case 'photos':
      return null
  }
}

/** The facts of a validated submission (`validateSubmission` has already dropped what does not apply). */
export function extractFacts(form: FormDef, answers: Readonly<Record<string, CleanAnswer>>): Facts {
  const facts: Record<string, FactValue> = {}
  for (const field of allFields(form)) {
    if (!field.fact || !Object.hasOwn(answers, field.id)) continue
    const value = toFact(field, field.fact, answers[field.id])
    if (value !== null) facts[field.fact.key] = value
  }
  return { schema: 'dig.facts/1', form: form.type, formVersion: form.version, facts }
}

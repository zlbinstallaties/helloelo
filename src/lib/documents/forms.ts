/*
 * The schouw (survey) and oplever (handover) forms, as data. No I/O and no framework imports, so the same
 * definition drives the form on the phone, the validation on the server and the PDF.
 *
 * The fields below are EXAMPLE FIELDS until the real paper or Word forms are available. Replacing them is a change
 * to this file only: `submission.ts` and `render.ts` work from whatever is listed here.
 */

export const DOCUMENT_TYPES = ['schouw', 'oplevering'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export type YesNo = 'ja' | 'nee' | 'nvt'

type FieldBase = {
  /** Stable key of the answer. Never change an id of a form that has been used; add a new field instead. */
  id: string
  label: string
  help?: string
  required?: boolean
}

export type TextField = FieldBase & { kind: 'text' }
export type TextAreaField = FieldBase & { kind: 'textarea' }
export type NumberField = FieldBase & { kind: 'number'; unit?: string }
export type DateField = FieldBase & { kind: 'date' }
export type ChoiceField = FieldBase & { kind: 'choice'; options: ReadonlyArray<{ value: string; label: string }> }
export type YesNoField = FieldBase & {
  kind: 'yesno'
  /** Offer "niet van toepassing" next to ja and nee. */
  allowNa?: boolean
  /** Ask for an explanation when the answer is this one. */
  explainWhen?: 'ja' | 'nee'
}
export type PhotosField = FieldBase & { kind: 'photos'; max: number }

export type FieldDef = TextField | TextAreaField | NumberField | DateField | ChoiceField | YesNoField | PhotosField

export type SectionDef = {
  id: string
  title: string
  fields: ReadonlyArray<FieldDef>
}

export type FormDef = {
  type: DocumentType
  /** Title on the screen and on top of the PDF. */
  title: string
  intro: string
  /** Start of the file name, e.g. `schouw-jansen-20261008.pdf`. */
  filePrefix: string
  /** The sentence the customer signs under. */
  signatureStatement: string
  sections: ReadonlyArray<SectionDef>
}

const WORK_TYPES = [
  { value: 'verwarming', label: 'Verwarming (cv)' },
  { value: 'warmtepomp', label: 'Warmtepomp' },
  { value: 'elektra', label: 'Elektra' },
  { value: 'sanitair', label: 'Sanitair of badkamer' },
  { value: 'ventilatie', label: 'Ventilatie of airco' },
  { value: 'anders', label: 'Anders' },
] as const

export const FORMS: Readonly<Record<DocumentType, FormDef>> = {
  schouw: {
    type: 'schouw',
    title: 'Schouwdocument',
    intro: 'Leg de situatie ter plekke vast. De klant tekent onderaan voor akkoord.',
    filePrefix: 'schouw',
    signatureStatement: 'Ik heb bij de schouw aanwezig kunnen zijn en ga akkoord met de vastgelegde situatie.',
    sections: [
      {
        id: 'locatie',
        title: 'Locatie',
        fields: [
          { id: 'toegang', kind: 'textarea', label: 'Bereikbaarheid van de locatie', help: 'Denk aan trappen, sleutel, bellen vooraf.' },
          { id: 'parkeren', kind: 'yesno', label: 'Parkeergelegenheid voor het voertuig aanwezig', required: true, explainWhen: 'nee' },
          { id: 'huisdieren', kind: 'yesno', label: 'Huisdieren aanwezig', required: true, explainWhen: 'ja' },
        ],
      },
      {
        id: 'situatie',
        title: 'Bestaande situatie',
        fields: [
          { id: 'werkzaamheden', kind: 'choice', label: 'Soort werkzaamheden', required: true, options: WORK_TYPES },
          { id: 'bouwjaar', kind: 'number', label: 'Bouwjaar woning' },
          { id: 'meterkast', kind: 'yesno', label: 'Voldoende ruimte in de meterkast', required: true, allowNa: true, explainWhen: 'nee' },
          { id: 'asbest', kind: 'yesno', label: 'Vermoeden van asbest', required: true, explainWhen: 'ja' },
          { id: 'ruimte', kind: 'textarea', label: 'Afmetingen en bijzonderheden van de ruimte' },
        ],
      },
      {
        id: 'fotos',
        title: "Foto's",
        fields: [{ id: 'fotos_situatie', kind: 'photos', label: "Foto's van de situatie", max: 8 }],
      },
      {
        id: 'afronding',
        title: 'Afronding',
        fields: [
          { id: 'aandachtspunten', kind: 'textarea', label: 'Aandachtspunten voor de uitvoering' },
          { id: 'opmerkingen_klant', kind: 'textarea', label: 'Opmerkingen van de klant' },
        ],
      },
    ],
  },
  oplevering: {
    type: 'oplevering',
    title: 'Opleverdocument',
    intro: 'Leg de oplevering vast. De klant tekent onderaan voor ontvangst.',
    filePrefix: 'oplevering',
    signatureStatement: 'Ik verklaar dat de werkzaamheden zijn opgeleverd zoals hierboven vermeld.',
    sections: [
      {
        id: 'werk',
        title: 'Uitgevoerde werkzaamheden',
        fields: [
          { id: 'uitgevoerd', kind: 'textarea', label: 'Wat is er uitgevoerd?', required: true },
          { id: 'volledig', kind: 'yesno', label: 'Werkzaamheden volledig uitgevoerd', required: true, explainWhen: 'nee' },
          { id: 'getest', kind: 'yesno', label: 'Installatie getest en in werking', required: true, allowNa: true, explainWhen: 'nee' },
        ],
      },
      {
        id: 'oplevering',
        title: 'Oplevering',
        fields: [
          { id: 'instructie', kind: 'yesno', label: 'Uitleg gegeven aan de klant', required: true, allowNa: true },
          { id: 'opgeruimd', kind: 'yesno', label: 'Werkplek opgeruimd en schoongemaakt', required: true, explainWhen: 'nee' },
          { id: 'restpunten', kind: 'textarea', label: 'Restpunten of vervolgafspraken' },
        ],
      },
      {
        id: 'fotos',
        title: "Foto's",
        fields: [{ id: 'fotos_resultaat', kind: 'photos', label: "Foto's van het eindresultaat", max: 8 }],
      },
      {
        id: 'afronding',
        title: 'Afronding',
        fields: [{ id: 'opmerkingen_klant', kind: 'textarea', label: 'Opmerkingen van de klant' }],
      },
    ],
  },
}

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value)
}

export function allFields(form: FormDef): FieldDef[] {
  return form.sections.flatMap((section) => [...section.fields])
}

export const YES_NO_LABELS: Readonly<Record<YesNo, string>> = {
  ja: 'Ja',
  nee: 'Nee',
  nvt: 'Niet van toepassing',
}

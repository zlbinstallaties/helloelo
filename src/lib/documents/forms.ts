/*
 * The schouw (survey) and oplever (handover) forms, as data. No I/O and no framework imports, so the same
 * definition drives the form on the phone, the validation on the server and the PDF.
 *
 * Status of the content:
 *  - schouw (version 2): built from the "Schouw MVP" of the DIG masterprompt (section 6): installation type, existing
 *    situation, placement inside or outside, pipe or cable route and estimated length, electrical supply, hydraulics where
 *    relevant, work for the client (digging, power, clearing space), photos, points of attention and the judgement
 *    "complete for work preparation". It is a PROVISIONAL core: it has not been compared with the paper or Word form of
 *    De Installatiegroep yet. It asks for what was seen or measured and never fills in a technical value.
 *  - oplevering (version 2): the handover AND the commissioning (inbedrijfstelling, IBS) document, for monoblock heat pumps
 *    and split systems; the parts that only apply to one of them are shown only for that choice (`showWhen`). Also
 *    PROVISIONAL: it is no replacement for the commissioning protocol of the manufacturer (the form says so), and it has
 *    not been compared with the IBS document of De Installatiegroep yet.
 *
 * Changing a form is a change to this file only: `submission.ts`, the screen and `render.ts` work from whatever is listed
 * here. Never change the `id` of a field that has been used; add a new field instead, and raise `version` when the
 * questions change in a way that matters for a document that was made earlier.
 */

export const DOCUMENT_TYPES = ['schouw', 'oplevering'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export type YesNo = 'ja' | 'nee' | 'nvt'

/**
 * What an answer is called for other systems, such as the quotation engine (the offerte-assistent): a stable key, like the
 * `id`. See `facts.ts`. A choice can map its values (a value that maps to null, or that is missing, is left out); without a
 * map the value is used as it is, except "onbekend" and "nvt", which are never a fact.
 */
export type FactDef = { key: string; values?: Readonly<Record<string, string | boolean | null>> }

/** Show a section or a field only when an EARLIER choice field has one of these values. */
export type ShowWhen = { field: string; in: readonly string[] }

type FieldBase = {
  /** The name of this answer for other systems (see `FactDef`). Only answers that are useful outside the form have one. */
  fact?: FactDef
  /** Show the field only for some answers (see `ShowWhen`). A hidden field is never asked, checked or printed. */
  showWhen?: ShowWhen
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
  /** Show the whole section only for some answers (see `ShowWhen`). */
  showWhen?: ShowWhen
  fields: ReadonlyArray<FieldDef>
}

export type FormDef = {
  type: DocumentType
  /** Raised when the questions change; printed on the PDF so that an old document can be read against the right form. */
  version: number
  /** Title on the screen and on top of the PDF. */
  title: string
  intro: string
  /** Start of the file name, e.g. `schouw-jansen-20261008.pdf`. */
  filePrefix: string
  /** The sentence the customer signs under. */
  signatureStatement: string
  sections: ReadonlyArray<SectionDef>
}

const INSTALLATION_TYPES = [
  { value: 'warmtepomp_hybride', label: 'Hybride warmtepomp' },
  { value: 'warmtepomp_all_electric', label: 'All-electric warmtepomp' },
  { value: 'airco', label: 'Airco' },
  { value: 'thuisbatterij', label: 'Thuisbatterij' },
  { value: 'vloerverwarming', label: 'Vloerverwarming' },
  { value: 'ventilatie', label: 'Ventilatie' },
  { value: 'sanitair', label: 'Sanitair of loodgieterswerk' },
  { value: 'anders', label: 'Anders (zie toelichting)' },
] as const

const PLACEMENT = [
  { value: 'binnen', label: 'Binnen' },
  { value: 'buiten', label: 'Buiten' },
  { value: 'binnen_buiten', label: 'Binnen en buiten' },
  { value: 'nog_niet_bepaald', label: 'Nog niet bepaald' },
] as const

const ELECTRICAL_SUPPLY = [
  { value: '1-fase', label: 'Enkelfase (1-fase)' },
  { value: '3-fase', label: 'Driefase (3-fase)' },
  { value: 'onbekend', label: 'Onbekend' },
] as const

const FREE_GROUP = [
  { value: 'ja', label: 'Ja' },
  { value: 'nee', label: 'Nee' },
  { value: 'onbekend', label: 'Onbekend' },
  { value: 'nvt', label: 'Niet van toepassing' },
] as const

/** The words of the quotation engine: vloer, radiatoren, lt_radiatoren (low-temperature) and mix. */
const EMISSION = [
  { value: 'vloer', label: 'Vloerverwarming' },
  { value: 'radiatoren', label: 'Radiatoren' },
  { value: 'lt_radiatoren', label: 'Lage-temperatuurradiatoren' },
  { value: 'mix', label: 'Gemengd (vloer en radiatoren)' },
  { value: 'onbekend', label: 'Onbekend' },
  { value: 'nvt', label: 'Niet van toepassing' },
] as const

const INSULATION = [
  { value: 'goed', label: 'Goed' },
  { value: 'matig', label: 'Matig' },
  { value: 'slecht', label: 'Slecht' },
  { value: 'onbekend', label: 'Onbekend' },
] as const

const SPACE = [
  { value: 'weinig', label: 'Weinig' },
  { value: 'voldoende', label: 'Voldoende' },
  { value: 'onbekend', label: 'Onbekend' },
] as const

const BOILER = [
  { value: 'horizontaal', label: 'Horizontaal' },
  { value: 'staand', label: 'Staand' },
  { value: 'onbekend', label: 'Onbekend' },
] as const

const SYSTEM_TYPES = [
  { value: 'monoblock', label: 'Monoblock warmtepomp' },
  { value: 'split', label: 'Split-systeem' },
  { value: 'overig', label: 'Overig (alleen oplevering, geen inbedrijfstelling)' },
] as const

/** The parts of the commissioning (IBS) apply to a monoblock heat pump and to a split system. */
const COMMISSIONING = { field: 'systeem', in: ['monoblock', 'split'] } as const
const MONOBLOCK = { field: 'systeem', in: ['monoblock'] } as const
const SPLIT = { field: 'systeem', in: ['split'] } as const

export const FORMS: Readonly<Record<DocumentType, FormDef>> = {
  schouw: {
    type: 'schouw',
    version: 2,
    title: 'Schouwdocument',
    intro: 'Leg de situatie ter plekke vast. Vul alleen in wat is gezien of gemeten; laat een veld leeg of kies Onbekend als iets nog niet te bepalen is. De klant tekent onderaan voor akkoord.',
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
        id: 'installatie',
        title: 'Installatie en plaatsing',
        fields: [
          { id: 'werkzaamheden', kind: 'choice', label: 'Installatietype', required: true, options: INSTALLATION_TYPES, fact: { key: 'gewenst_systeem', values: { warmtepomp_hybride: 'hybride', warmtepomp_all_electric: 'all-electric' } } },
          { id: 'installatie_toelichting', kind: 'textarea', label: 'Toelichting bij het installatietype', help: 'Vul dit in als u Anders kiest, of als het om een combinatie gaat.' },
          { id: 'plaatsing', kind: 'choice', label: 'Plaatsing', required: true, options: PLACEMENT },
          { id: 'plaatsing_toelichting', kind: 'textarea', label: 'Waar komt de installatie te staan?' },
          { id: 'ruimte_installatie', kind: 'choice', label: 'Ruimte voor de installatie', options: SPACE, fact: { key: 'ruimte_installatie' } },
          { id: 'boiler_opstelling', kind: 'choice', label: 'Opstelling van de boiler of buffer', help: 'Alleen invullen als er een boiler of buffer komt.', options: BOILER, fact: { key: 'boiler_opstelling' } },
        ],
      },
      {
        id: 'situatie',
        title: 'Bestaande situatie',
        fields: [
          { id: 'bestaand', kind: 'textarea', label: 'Bestaande installatie en afgifte', help: 'Wat staat er nu en in welke staat?' },
          { id: 'bouwjaar', kind: 'number', label: 'Bouwjaar woning', fact: { key: 'bouwjaar' } },
          { id: 'isolatie', kind: 'choice', label: 'Isolatie van de woning', help: 'Uw eigen beoordeling ter plekke.', options: INSULATION, fact: { key: 'isolatie' } },
          { id: 'personen', kind: 'number', label: 'Aantal personen in de woning', fact: { key: 'aantal_personen' } },
          { id: 'gasverbruik', kind: 'number', label: 'Jaarverbruik gas', unit: 'm³ per jaar', help: 'Van de jaarafrekening. Laat leeg als dit niet bekend is.', fact: { key: 'gasverbruik_m3_per_jaar' } },
          { id: 'ruimte', kind: 'textarea', label: 'Afmetingen en bijzonderheden van de ruimte' },
          { id: 'asbest', kind: 'yesno', label: 'Vermoeden van asbest', required: true, explainWhen: 'ja', fact: { key: 'asbest_vermoed' } },
        ],
      },
      {
        id: 'tracé',
        title: 'Leidingtracé of kabeltracé',
        fields: [
          { id: 'trace_nodig', kind: 'yesno', label: 'Leiding- of kabeltracé nodig', allowNa: true },
          { id: 'trace_lengte', kind: 'number', label: 'Geschatte lengte van het tracé', unit: 'm', help: 'Laat leeg als dit nog niet te schatten is.', fact: { key: 'leidinglengte_m' } },
          { id: 'trace_toelichting', kind: 'textarea', label: 'Tracé, doorvoeren en obstakels', fact: { key: 'leidingroute' } },
        ],
      },
      {
        id: 'elektra',
        title: 'Elektrische voorziening',
        fields: [
          { id: 'meterkast', kind: 'yesno', label: 'Voldoende ruimte in de meterkast', required: true, allowNa: true, explainWhen: 'nee', fact: { key: 'ruimte_meterkast' } },
          { id: 'aansluiting', kind: 'choice', label: 'Aansluiting', options: ELECTRICAL_SUPPLY, fact: { key: 'aansluiting' } },
          { id: 'groep_vrij', kind: 'choice', label: 'Vrije groep beschikbaar in de groepenkast', options: FREE_GROUP, fact: { key: 'groep_vrij', values: { ja: true, nee: false } } },
          { id: 'elektra_toelichting', kind: 'textarea', label: 'Aandachtspunten elektra' },
        ],
      },
      {
        id: 'hydrauliek',
        title: 'Hydraulische aspecten',
        fields: [
          { id: 'afgifte', kind: 'choice', label: 'Warmteafgifte', help: 'Alleen invullen als dit voor de installatie speelt.', options: EMISSION, fact: { key: 'afgiftesysteem' } },
          { id: 'hydrauliek_toelichting', kind: 'textarea', label: 'Aandachtspunten hydrauliek' },
        ],
      },
      {
        id: 'opdrachtgever',
        title: 'Werkzaamheden voor de opdrachtgever',
        fields: [
          { id: 'graafwerk_klant', kind: 'yesno', label: 'Graafwerk door de opdrachtgever nodig', required: true, allowNa: true, explainWhen: 'ja', fact: { key: 'graafwerk_door_klant' } },
          { id: 'stroom_klant', kind: 'yesno', label: 'Stroomvoorziening door de opdrachtgever te regelen', required: true, allowNa: true, explainWhen: 'ja', fact: { key: 'stroom_door_klant' } },
          { id: 'werkruimte_klant', kind: 'yesno', label: 'Werkruimte door de opdrachtgever vrij te maken', required: true, allowNa: true, explainWhen: 'ja', fact: { key: 'werkruimte_door_klant' } },
        ],
      },
      {
        id: 'fotos',
        title: "Foto's",
        fields: [
          { id: 'fotos_situatie', kind: 'photos', label: "Foto's van de situatie en de plaatsing", max: 8 },
          { id: 'fotos_meterkast', kind: 'photos', label: "Foto's van de meterkast en groepenkast", max: 4 },
        ],
      },
      {
        id: 'afronding',
        title: 'Afronding',
        fields: [
          { id: 'aandachtspunten', kind: 'textarea', label: 'Aandachtspunten voor de uitvoering' },
          { id: 'opmerkingen_klant', kind: 'textarea', label: 'Opmerkingen van de klant' },
          { id: 'beoordeling', kind: 'yesno', label: 'Compleet voor de werkvoorbereiding', help: 'Kies Nee als er nog gegevens ontbreken en zeg welke.', required: true, explainWhen: 'nee', fact: { key: 'schouw_compleet' } },
        ],
      },
    ],
  },
  oplevering: {
    type: 'oplevering',
    version: 2,
    title: 'Opleverdocument en inbedrijfstelling',
    intro: 'Leg de oplevering vast en, bij een warmtepomp, ook de inbedrijfstelling (IBS). Vul alleen in wat is gecontroleerd of gemeten. Dit formulier vervangt het inbedrijfstellingsprotocol van de fabrikant niet. De klant tekent onderaan voor ontvangst.',
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
        id: 'systeem',
        title: 'Soort installatie',
        fields: [{ id: 'systeem', kind: 'choice', label: 'Soort installatie', required: true, options: SYSTEM_TYPES, fact: { key: 'systeem_type', values: { monoblock: 'monoblock', split: 'split' } } }],
      },
      {
        id: 'apparatuur',
        title: 'Apparatuur',
        showWhen: COMMISSIONING,
        fields: [
          { id: 'merk', kind: 'text', label: 'Merk', required: true, fact: { key: 'apparaat_merk' } },
          { id: 'model', kind: 'text', label: 'Type of model', required: true, fact: { key: 'apparaat_model' } },
          { id: 'serienummer_buiten', kind: 'text', label: 'Serienummer buitenunit', required: true, fact: { key: 'serienummer_buitenunit' } },
          { id: 'serienummer_binnen', kind: 'text', label: 'Serienummer binnenunit of hydrobox', help: 'Laat leeg als er geen aparte binnenunit of hydrobox is.', fact: { key: 'serienummer_binnenunit' } },
          { id: 'gegevens_gecontroleerd', kind: 'yesno', label: 'Merk, type en serienummers zijn van de typeplaatjes overgenomen', required: true, explainWhen: 'nee' },
          { id: 'fotos_typeplaatje', kind: 'photos', label: "Foto's van de typeplaatjes", max: 4 },
        ],
      },
      {
        id: 'ibs',
        title: 'Inbedrijfstelling',
        showWhen: COMMISSIONING,
        fields: [
          { id: 'ibs_datum', kind: 'date', label: 'Datum inbedrijfstelling', required: true, fact: { key: 'inbedrijfstelling_datum' } },
          { id: 'fabrikant_protocol', kind: 'yesno', label: 'Inbedrijfstellingsprotocol van de fabrikant doorlopen', required: true, explainWhen: 'nee' },
          { id: 'voeding', kind: 'yesno', label: 'Elektrische aansluiting en beveiliging gecontroleerd', required: true, allowNa: true, explainWhen: 'nee' },
          { id: 'opstelling', kind: 'yesno', label: 'Opstelling van de buitenunit gecontroleerd', help: 'Stabiel geplaatst, vrije luchtstroom, condensafvoer.', required: true, allowNa: true, explainWhen: 'nee' },
          { id: 'storingen', kind: 'yesno', label: 'Storingsmelding of foutcode na de proefrun', required: true, explainWhen: 'ja' },
        ],
      },
      {
        id: 'metingen',
        title: 'Meetwaarden',
        showWhen: COMMISSIONING,
        fields: [
          { id: 'buitentemperatuur', kind: 'number', label: 'Buitentemperatuur tijdens de meting', unit: '°C', help: 'Alleen invullen wat is gemeten; laat leeg wat niet is gemeten.' },
          { id: 'aanvoer_temp', kind: 'number', label: 'Aanvoertemperatuur', unit: '°C' },
          { id: 'retour_temp', kind: 'number', label: 'Retourtemperatuur', unit: '°C' },
          { id: 'debiet', kind: 'number', label: 'Debiet', unit: 'l/min' },
          { id: 'meting_toelichting', kind: 'textarea', label: 'Meetomstandigheden en instellingen', help: 'Bijvoorbeeld de ingestelde stooklijn of temperatuur.' },
        ],
      },
      {
        id: 'monoblock',
        title: 'Monoblock: waterzijdig',
        showWhen: MONOBLOCK,
        fields: [
          { id: 'mb_gespoeld', kind: 'yesno', label: 'Installatie gespoeld en ontlucht', required: true, allowNa: true, explainWhen: 'nee' },
          { id: 'mb_vorst', kind: 'yesno', label: 'Vorstbescherming van de leidingen buiten geregeld', required: true, allowNa: true, explainWhen: 'nee' },
          { id: 'mb_isolatie', kind: 'yesno', label: 'Leidingen en aansluitingen buiten geïsoleerd', required: true, allowNa: true, explainWhen: 'nee' },
          { id: 'mb_druk', kind: 'number', label: 'Waterdruk na het vullen', unit: 'bar' },
        ],
      },
      {
        id: 'split',
        title: 'Split-systeem: koudemiddelcircuit',
        showWhen: SPLIT,
        fields: [
          { id: 'sp_dichtheid', kind: 'yesno', label: 'Koudemiddelleidingen op dichtheid gecontroleerd', required: true, allowNa: true, explainWhen: 'nee' },
          { id: 'sp_vacuum', kind: 'yesno', label: 'Koudemiddelleidingen vacuüm getrokken', required: true, allowNa: true, explainWhen: 'nee' },
          { id: 'sp_certificaat', kind: 'yesno', label: 'Koudemiddelwerk uitgevoerd door een daarvoor gecertificeerde monteur', required: true, explainWhen: 'nee' },
          { id: 'sp_certificaatnummer', kind: 'text', label: 'Certificaatnummer van de monteur' },
          { id: 'sp_koudemiddel', kind: 'text', label: 'Type koudemiddel', help: 'Zoals op het typeplaatje staat.', fact: { key: 'koudemiddel_type' } },
          { id: 'sp_lading', kind: 'number', label: 'Totale hoeveelheid koudemiddel', unit: 'kg', fact: { key: 'koudemiddel_kg' } },
          { id: 'sp_bijgevuld', kind: 'number', label: 'Extra bijgevuld', unit: 'kg' },
          { id: 'sp_leidinglengte', kind: 'number', label: 'Lengte van de koudemiddelleidingen', unit: 'm', fact: { key: 'koudemiddelleiding_m' } },
        ],
      },
      {
        id: 'oplevering',
        title: 'Oplevering aan de klant',
        fields: [
          { id: 'instructie', kind: 'yesno', label: 'Uitleg gegeven aan de klant', required: true, allowNa: true },
          { id: 'documenten', kind: 'yesno', label: 'Handleiding en garantiebewijs overhandigd', required: true, allowNa: true },
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

/** Whether a section or field applies, given the answers so far (a choice answer is its value as text). */
export function isVisible(item: { showWhen?: ShowWhen }, answers: Readonly<Record<string, unknown>>): boolean {
  if (!item.showWhen) return true
  const answer = answers[item.showWhen.field]
  return typeof answer === 'string' && item.showWhen.in.includes(answer)
}

/** The sections that apply to these answers, each with the fields that apply, in the order of the form. */
export function visibleSections(form: FormDef, answers: Readonly<Record<string, unknown>>): Array<{ section: SectionDef; fields: FieldDef[] }> {
  return form.sections
    .filter((section) => isVisible(section, answers))
    .map((section) => ({ section, fields: section.fields.filter((field) => isVisible(field, answers)) }))
    .filter(({ fields }) => fields.length > 0)
}

export const YES_NO_LABELS: Readonly<Record<YesNo, string>> = {
  ja: 'Ja',
  nee: 'Nee',
  nvt: 'Niet van toepassing',
}

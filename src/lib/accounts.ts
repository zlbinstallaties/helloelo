import { randomBytes } from 'node:crypto'
import { hashPassword, isPasswordHash, passwordProblem, verifyPassword } from './password.ts'

/*
 * The accounts of the dashboard: who may log in, as what, and (for a technician) whose planning they see.
 * Accounts are made by an admin; there is no sign-up. Only a password hash is stored.
 *
 * The store works on a file through `AccountIo` (read all, write all), so this file has no I/O of its own and
 * is unit-tested in test/. Every operation reads the file first and writes it at most once, synchronously, so
 * within one process a change can never overwrite another one.
 */

export const ROLES = ['admin', 'monteur'] as const
export type Role = (typeof ROLES)[number]

/** What the rest of the program may see of an account: never the hash. */
export type PublicAccount = {
  id: string
  username: string
  name: string
  role: Role
  /** Person id from the planning (`employee:7`, see DashboardPerson); the planning a technician sees. */
  personId: string | null
  disabled: boolean
  createdAt: string
}

type StoredAccount = PublicAccount & { passwordHash: string; sessionVersion: number }

export interface AccountIo {
  /** The whole file, or null when it does not exist yet. */
  read(): string | null
  write(text: string): void
}

export class AccountError extends Error {
  code: 'invalid' | 'conflict' | 'not_found'

  constructor(code: 'invalid' | 'conflict' | 'not_found', message: string) {
    super(message)
    this.name = 'AccountError'
    this.code = code
  }
}

/** The file exists but cannot be trusted. Never "fixed" by starting empty: that would wipe the accounts. */
export class AccountsFileError extends Error {
  constructor(message: string) {
    super(`Het accountbestand is ongeldig: ${message}`)
    this.name = 'AccountsFileError'
  }
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/
const PERSON_ID = /^(?:(?:employee|user):[0-9]{1,12}|name:.{1,190})$/
const FILE_VERSION = 1

export function normalizeUsername(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export interface AccountStoreOptions {
  io: AccountIo
  now?: () => Date
  newId?: () => string
  /** User names an account may not take (the emergency admin). */
  reservedUsernames?: string[]
}

export type NewAccount = {
  username: string
  name: string
  role: Role
  personId: string | null
  password: string
}

export type AccountChanges = Partial<Pick<PublicAccount, 'name' | 'role' | 'personId' | 'disabled'>>

function toPublic(account: StoredAccount): PublicAccount {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    role: account.role,
    personId: account.personId,
    disabled: account.disabled,
    createdAt: account.createdAt,
  }
}

function parseFile(text: string | null): StoredAccount[] {
  if (text === null) return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new AccountsFileError('geen geldige JSON.')
  }
  const file = data as { version?: unknown; accounts?: unknown } | null
  if (typeof file !== 'object' || file === null || Array.isArray(file) || file.version !== FILE_VERSION || !Array.isArray(file.accounts)) {
    throw new AccountsFileError(`verwacht { "version": ${FILE_VERSION}, "accounts": [...] }.`)
  }
  const ids = new Set<string>()
  const usernames = new Set<string>()
  const people = new Set<string>()
  return file.accounts.map((raw: unknown, index: number): StoredAccount => {
    const a = raw as Record<string, unknown>
    const where = `account ${index + 1}`
    if (
      typeof a?.id !== 'string' || !a.id ||
      typeof a.username !== 'string' || !USERNAME.test(a.username) ||
      typeof a.name !== 'string' || !a.name ||
      !ROLES.includes(a.role as Role) ||
      !(a.personId === null || (typeof a.personId === 'string' && PERSON_ID.test(a.personId))) ||
      typeof a.disabled !== 'boolean' ||
      typeof a.createdAt !== 'string' ||
      !isPasswordHash(a.passwordHash) ||
      !Number.isInteger(a.sessionVersion) || (a.sessionVersion as number) < 0
    ) {
      throw new AccountsFileError(`${where} mist een veld of heeft een onjuiste waarde.`)
    }
    if (ids.has(a.id)) throw new AccountsFileError(`${where}: dubbel id.`)
    if (usernames.has(a.username)) throw new AccountsFileError(`${where}: dubbele gebruikersnaam.`)
    if (typeof a.personId === 'string' && people.has(a.personId)) throw new AccountsFileError(`${where}: dubbele persoon.`)
    ids.add(a.id)
    usernames.add(a.username)
    if (typeof a.personId === 'string') people.add(a.personId)
    return a as unknown as StoredAccount
  })
}

export function createAccountStore(options: AccountStoreOptions) {
  const { io } = options
  const now = options.now ?? (() => new Date())
  const newId = options.newId ?? (() => `u_${randomBytes(9).toString('base64url')}`)
  const reserved = new Set((options.reservedUsernames ?? []).map(normalizeUsername))
  // Checked against when the user name does not exist, so that "unknown user" takes as long as "wrong password".
  let dummyHash: string | null = null

  const load = () => parseFile(io.read())
  const save = (accounts: StoredAccount[]) => io.write(JSON.stringify({ version: FILE_VERSION, accounts }, null, 2))
  const find = (accounts: StoredAccount[], id: string) => {
    const account = accounts.find((item) => item.id === id)
    if (!account) throw new AccountError('not_found', 'Account niet gevonden.')
    return account
  }

  function checkName(value: unknown) {
    const name = typeof value === 'string' ? value.trim() : ''
    if (name.length < 1 || name.length > 80) throw new AccountError('invalid', 'De naam moet 1 tot 80 tekens zijn.')
    return name
  }

  function checkRole(value: unknown): Role {
    if (!ROLES.includes(value as Role)) throw new AccountError('invalid', 'Onbekende rol.')
    return value as Role
  }

  function checkPerson(value: unknown, role: Role) {
    const personId = typeof value === 'string' && value.trim() ? value.trim() : null
    if (personId === null) {
      if (role === 'monteur') throw new AccountError('invalid', 'Kies de persoon uit de planning waar dit account bij hoort.')
      return null
    }
    if (!PERSON_ID.test(personId)) throw new AccountError('invalid', 'Onbekende persoon.')
    return personId
  }

  function checkPersonFree(accounts: StoredAccount[], personId: string | null, exceptId?: string) {
    if (personId !== null && accounts.some((item) => item.personId === personId && item.id !== exceptId)) {
      throw new AccountError('conflict', 'Er is al een account voor deze persoon.')
    }
  }

  function checkPassword(password: unknown) {
    const problem = passwordProblem(password)
    if (problem) throw new AccountError('invalid', problem)
    return password as string
  }

  return {
    list(): PublicAccount[] {
      return load()
        .map(toPublic)
        .sort((a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' }) || a.username.localeCompare(b.username))
    },

    get(id: string): PublicAccount | undefined {
      const account = load().find((item) => item.id === id)
      return account ? toPublic(account) : undefined
    },

    findByPerson(personId: string): PublicAccount | undefined {
      const account = load().find((item) => item.personId === personId)
      return account ? toPublic(account) : undefined
    },

    /** The session version of an account, or null when it does not exist. */
    sessionVersion(id: string): number | null {
      return load().find((item) => item.id === id)?.sessionVersion ?? null
    },

    create(input: NewAccount): PublicAccount {
      const accounts = load()
      const username = normalizeUsername(input.username)
      if (!USERNAME.test(username)) {
        throw new AccountError('invalid', 'De gebruikersnaam moet 3 tot 40 tekens zijn: letters, cijfers, punt, streepje of underscore, beginnend met een letter of cijfer.')
      }
      if (reserved.has(username) || accounts.some((item) => item.username === username)) {
        throw new AccountError('conflict', 'Deze gebruikersnaam bestaat al.')
      }
      const name = checkName(input.name)
      const role = checkRole(input.role)
      const personId = checkPerson(input.personId, role)
      checkPersonFree(accounts, personId)
      const password = checkPassword(input.password)

      let id = newId()
      for (let attempt = 0; accounts.some((item) => item.id === id); attempt++) {
        if (attempt >= 10) throw new Error('could not find a free account id')
        id = newId()
      }
      const account: StoredAccount = {
        id,
        username,
        name,
        role,
        personId,
        disabled: false,
        createdAt: now().toISOString(),
        passwordHash: hashPassword(password),
        sessionVersion: 0,
      }
      save([...accounts, account])
      return toPublic(account)
    },

    update(id: string, changes: AccountChanges): PublicAccount {
      const accounts = load()
      const account = find(accounts, id)
      const name = changes.name === undefined ? account.name : checkName(changes.name)
      const role = changes.role === undefined ? account.role : checkRole(changes.role)
      const personId = changes.personId === undefined && changes.role === undefined ? account.personId : checkPerson(changes.personId === undefined ? account.personId : changes.personId, role)
      checkPersonFree(accounts, personId, id)
      const disabled = changes.disabled === undefined ? account.disabled : Boolean(changes.disabled)
      // What an account may do changed: its sessions end, so it has to log in again with the new rights.
      const rightsChanged = role !== account.role || personId !== account.personId || disabled !== account.disabled
      Object.assign(account, { name, role, personId, disabled, sessionVersion: account.sessionVersion + (rightsChanged ? 1 : 0) })
      save(accounts)
      return toPublic(account)
    },

    resetPassword(id: string, password: string): void {
      const accounts = load()
      const account = find(accounts, id)
      account.passwordHash = hashPassword(checkPassword(password))
      account.sessionVersion += 1
      save(accounts)
    },

    changeOwnPassword(id: string, current: string, next: string): void {
      const accounts = load()
      const account = find(accounts, id)
      if (!verifyPassword(current, account.passwordHash)) throw new AccountError('invalid', 'Het huidige wachtwoord klopt niet.')
      account.passwordHash = hashPassword(checkPassword(next))
      account.sessionVersion += 1
      save(accounts)
    },

    remove(id: string): void {
      const accounts = load()
      find(accounts, id)
      save(accounts.filter((item) => item.id !== id))
    },

    /** The account when the user name and password are right and the account is enabled; otherwise null. */
    authenticate(username: string, password: string): PublicAccount | null {
      const account = load().find((item) => item.username === normalizeUsername(username))
      dummyHash ??= hashPassword(randomBytes(12).toString('hex'))
      const right = verifyPassword(typeof password === 'string' ? password : '', account?.passwordHash ?? dummyHash)
      return account && right && !account.disabled ? toPublic(account) : null
    },
  }
}

export type AccountStore = ReturnType<typeof createAccountStore>

/** Error with an HTTP status and a stable, secret-free code for API clients. */
export class GatewayError extends Error {
  status: number
  code: string
  /** Extra, secret-free facts for the client (for example the id of a record that needs a look). */
  details?: Record<string, unknown>

  constructor(status: number, code: string, message = code, details?: Record<string, unknown>) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.code = code
    this.details = details
  }
}

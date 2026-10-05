/** Error with an HTTP status and a stable, secret-free code for API clients. */
export class GatewayError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message = code) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.code = code
  }
}

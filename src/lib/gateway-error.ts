/** An error from the Odoo gateway (or from its configuration). Pure, so the request handlers can be tested. */
export class GatewayError extends Error {
  status: number
  code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.code = code
  }
}

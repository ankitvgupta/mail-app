/**
 * Fixture shape (JSDoc, no runtime).
 *
 * @typedef {Object} SeedFixture
 * @property {string} id — stable identifier; used as Message-ID seed
 * @property {string} from — RFC 5322 From header value (e.g. `"Alice <alice@example.com>"`)
 * @property {string} [to] — RFC 5322 To header (defaults to the test account from EXOEMAILTEST_EMAIL)
 * @property {string} [cc] — optional Cc
 * @property {string} subject
 * @property {string} body — plain-text or HTML body
 * @property {boolean} [html] — true if `body` is HTML
 * @property {string} [date] — ISO 8601 date string (defaults to a spread over the last 30 days based on index)
 * @property {string} [inReplyTo] — Message-ID this is replying to (for threading)
 * @property {string[]} [references] — accumulating References chain for threading
 * @property {SeedAttachment[]} [attachments]
 */

/**
 * @typedef {Object} SeedAttachment
 * @property {string} filename
 * @property {string} mimeType
 * @property {string} contentBase64 — base64 (NOT base64url) of the attachment bytes
 */

export {};

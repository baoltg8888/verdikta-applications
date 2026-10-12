/**
 * The app-wide Express error handler.
 *
 * A request the CLIENT got wrong reaches it carrying the body parser's own
 * 4xx status: a body that is not valid JSON (express.json is strict, so a
 * bare JSON string is refused too), one over the size limit, an unsupported
 * encoding. It used to answer every one of them 500 INTERNAL_ERROR "check
 * server health", which agents read as an outage and retried — an agent sent
 * its work to POST /api/jobs/:id/submit/dry-run as a JSON string, got 500,
 * and deferred a finished submission until the bounty was won by someone
 * else. A client mistake now gets its own status and a fix; only a genuine
 * server fault is a 500.
 */
const { sendError, ErrorCodes } = require('./apiErrors');

/** The upload endpoints read multipart/form-data only. */
const MULTIPART_ROUTE = /\/submit(?:\/dry-run|\/bundle)?\/?$/;
const MULTIPART_FIX =
  'This endpoint takes multipart/form-data, not JSON: send each file under the field name "files" ' +
  'and the wallet under "hunter", e.g. curl -F "files=@result.json" -F "files=@evidence.md" -F "hunter=0x…"';

function apiErrorHandler(logger) {
  // Express recognises an error handler by its arity: keep all four parameters.
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = Number(err?.status ?? err?.statusCode);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      const multipart = MULTIPART_ROUTE.test(req.path || '');
      logger.warn('Client error', { status, type: err.type, path: req.path, msg: err.message });
      if (err.type === 'entity.parse.failed') {
        return sendError(res, 400, {
          code: ErrorCodes.INVALID_JSON,
          message: 'The request body is not valid JSON',
          details: err.message,
          fix: multipart
            ? MULTIPART_FIX
            : 'Send one JSON object or array with Content-Type: application/json (a bare JSON string is not accepted).',
        });
      }
      if (err.type === 'entity.too.large') {
        return sendError(res, 413, {
          code: ErrorCodes.PAYLOAD_TOO_LARGE,
          message: 'The request body is too large',
          details: err.message,
          fix: multipart ? MULTIPART_FIX : 'Send a smaller body (JSON bodies are limited to 2 MB).',
        });
      }
      return sendError(res, status, {
        code: ErrorCodes.BAD_REQUEST,
        message: err.expose && err.message ? err.message : 'Bad request',
        ...(multipart ? { fix: MULTIPART_FIX } : {}),
      });
    }
    logger.error('Server error:', err);
    return sendError(res, 500, {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err?.message : 'An unexpected error occurred',
      fix: 'Check server health at GET /health. If the problem persists, try again shortly.',
      tips: ['Check server health: GET /health', 'Full docs: GET /api/docs'],
    });
  };
}

module.exports = { apiErrorHandler, MULTIPART_FIX };

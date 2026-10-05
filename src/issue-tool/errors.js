/**
 * Errors for the Stock Issue Tool.
 *
 * Every error response has the shape
 *
 *   { "error": "Human-readable message", "code": "MACHINE_CODE", ...extra }
 *
 * which keeps the repo's `{ error }` convention and adds a stable code the
 * frontend can switch on. docs/issue-tool-api.md lists every code.
 */

export class ApiError extends Error {
	constructor(status, code, message, extra = {}) {
		super(message);
		this.status = status;
		this.code = code;
		this.extra = extra;
	}
}

/** HTTP status for each code the procedures raise. Unlisted codes are 400. */
const PROC_ERROR_STATUS = {
	UNKNOWN_ISSUE: 404,
	ALREADY_DELETED: 409,
	ISSUE_CONSUMED: 409,
	VOUCHER_NUMBER_CONFLICT: 409,
	LOCK_TIMEOUT: 503,
};

/**
 * The procedures raise domain errors as THROW 51000–51999 with a message
 * "CODE: text". Turn those into ApiErrors; anything else is left alone and
 * becomes a 500.
 */
export function fromSqlError(err) {
	const number = err?.number ?? err?.originalError?.info?.number;
	if (!(number >= 51000 && number < 52000)) return null;
	const match = /^([A-Z_]+):\s*([\s\S]*)$/.exec(err.message || '');
	const code = match ? match[1] : 'REJECTED';
	const message = match ? match[2] : err.message;
	return new ApiError(PROC_ERROR_STATUS[code] ?? 400, code, message);
}

/** Express error handler for the module's router. */
export function errorHandler(err, req, res, _next) {
	const apiError = err instanceof ApiError ? err : fromSqlError(err);
	if (apiError) {
		return res.status(apiError.status).json({
			error: apiError.message,
			code: apiError.code,
			...apiError.extra,
		});
	}
	console.error('[issue-tool] unhandled error:', err);
	return res.status(500).json({
		error: 'Something went wrong on the server. If you were saving, press Save again: the same form never creates a second voucher.',
		code: 'INTERNAL_ERROR',
	});
}

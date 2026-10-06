/**
 * Request validation for the Stock Issue Tool. Every query string and body
 * passes through one of these before it reaches SQL.
 */

import { z } from 'zod';
import { ApiError } from './errors.js';

const id = z.coerce.number().int().positive();
const bodyId = z.number().int().positive();
const flag = z
	.enum(['true', 'false', '1', '0'])
	.optional()
	.transform((v) => v === 'true' || v === '1');
const search = z.string().trim().max(100).optional().default('');

export const loginBody = z.object({
	username: z.string().trim().min(1, 'Enter your username.').max(100),
	database: z.string().trim().toUpperCase().pipe(z.enum(['KOL', 'AHM'])),
});

export const picklistsQuery = z.object({
	search,
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(5000).default(50),
	showFullyIssued: flag,
	/** Closed lines (IsCompleted = 1) instead of open ones, like the ERP's "Closed Allocation Picklist". */
	showClosed: flag,
});

export const picklistDetailIdParam = z.object({
	picklistDetailId: z.coerce.number().int().positive(),
});

/**
 * Job search for the direct tab, with the Job Card Generator's filters. At
 * least one filter is needed, so a search never lists every job ever booked.
 */
export const jobContentsQuery = z
	.object({
		search,
		clientName: z.string().trim().max(200).optional().default(''),
		salesPersonId: z.coerce.number().int().positive().optional(),
		fromDate: z.iso.date().optional(),
		toDate: z.iso.date().optional(),
		jobStatus: z.enum(['pending', 'closed', 'cancelled']).optional(),
	})
	.superRefine((q, ctx) => {
		if (q.search && q.search.length < 3) {
			ctx.addIssue({ code: 'custom', path: ['search'], message: 'Type at least 3 characters of the job number.' });
		}
		if (!q.search && !q.clientName && !q.salesPersonId && !q.fromDate && !q.toDate) {
			ctx.addIssue({ code: 'custom', path: ['search'], message: 'Enter a job number, or choose a client, sales person or job date.' });
		}
		if (q.fromDate && q.toDate && q.fromDate > q.toDate) {
			ctx.addIssue({ code: 'custom', path: ['fromDate'], message: 'The from date must not be after the to date.' });
		}
	});

export const itemsQuery = z
	.object({
		search,
		jobContentId: id.optional(),
	})
	.refine((q) => q.search.length >= 2 || q.jobContentId, {
		message: 'Type at least 2 characters, or pass jobContentId.',
		path: ['search'],
	});

export const itemIdParam = z.object({ itemId: id });
export const issueIdParam = z.object({ id });

export const issuesQuery = z.object({
	from: z.iso.date().optional(),
	to: z.iso.date().optional(),
});

const line = z.object({
	itemId: bodyId,
	parentTransactionId: z.number().int().min(0),
	warehouseId: z.number().int().min(0),
	batchNo: z.string().max(200).nullable().optional(),
	quantity: z.number().finite().positive('Quantity must be greater than zero.').max(1e9),
});

export const postIssueBody = z
	.object({
		mode: z.enum(['ALLOCATED', 'DIRECT']),
		requestId: z.uuid(),
		voucherDate: z.iso.date(),
		picklistDetailId: bodyId.optional(),
		jobContentId: bodyId.optional(),
		departmentId: bodyId.optional(),
		slipNo: z.string().trim().max(100).nullable().optional(),
		floorWarehouseId: bodyId,
		remark: z.string().trim().max(500).nullable().optional(),
		lines: z.array(line).min(1, 'Add at least one batch line.').max(50),
		dryRun: z.boolean().optional().default(false),
		acknowledgeWarnings: z.boolean().optional().default(false),
	})
	.superRefine((body, ctx) => {
		if (body.mode === 'ALLOCATED' && !body.picklistDetailId) {
			ctx.addIssue({ code: 'custom', path: ['picklistDetailId'], message: 'Required for an allocated issue.' });
		}
		if (body.mode === 'DIRECT') {
			if (!body.jobContentId) {
				ctx.addIssue({ code: 'custom', path: ['jobContentId'], message: 'Required for a direct issue.' });
			}
			if (!body.departmentId) {
				ctx.addIssue({ code: 'custom', path: ['departmentId'], message: 'Required for a direct issue.' });
			}
		}
	});

/** Parse or throw a 400 with every failing field listed. */
export function parse(schema, input) {
	const result = schema.safeParse(input ?? {});
	if (result.success) return result.data;
	const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
	throw new ApiError(400, 'VALIDATION_FAILED', details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('; '), { details });
}

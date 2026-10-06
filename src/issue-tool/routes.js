/**
 * CDC Stock Issue Tool API.
 *
 * Mounted at `/api/issue-tool` by src/server.js; every path below is relative
 * to that prefix. docs/issue-tool-api.md is the contract the frontend is built
 * from — keep it in sync with this file.
 *
 *   GET  /session                      who is signed in, site, writes on/off, today
 *   GET  /picklists                    open (or closed) picklist lines (allocated tab)
 *   POST /picklists/:id/close          close a picklist line (dry run unless writes are on)
 *   GET  /job-contents                 job contents by job number, client, sales person, date, status (direct tab)
 *   GET  /items                        item search, planned items first
 *   GET  /items/:itemId/batches        batch stock for an item
 *   GET  /lookups/floor-warehouses
 *   GET  /lookups/departments
 *   GET  /lookups/clients              clients with job cards (job search filter)
 *   GET  /lookups/sales-persons        sales executives (job search filter)
 *   POST /issues                       post an issue (dry run unless writes are on)
 *   GET  /issues                       recent issues with lines
 *   POST /issues/:id/delete            soft-delete an issue
 *   POST /issues/:id/refresh-stock     retry UPDATE_ITEM_STOCK_VALUES
 *
 *   POST /auth/login                   username + database → session token
 */

import { Router } from 'express';
import { authenticate, requireErpUser, login } from './auth.js';
import { ApiError, errorHandler } from './errors.js';
import { writesEnabled, RECENT_ISSUES_DEFAULT_DAYS, RECENT_ISSUES_MAX_DAYS } from './config.js';
import { todayInKolkata, addDays, daysBetween } from './dates.js';
import {
	parse, loginBody, picklistsQuery, picklistDetailIdParam, jobContentsQuery, itemsQuery, itemIdParam, issueIdParam, issuesQuery, postIssueBody,
} from './schemas.js';
import { listPicklistLines } from './queries/picklists.js';
import { searchJobContents } from './queries/job-contents.js';
import { searchItems, itemBatches } from './queries/items.js';
import { floorWarehouses, departments, clients, salesPersons } from './queries/lookups.js';
import { recentIssues } from './queries/issues.js';
import { postIssue, deleteIssue, retryStockRefresh } from './services/issues.js';
import { closePicklistLine } from './services/picklists.js';

const router = Router();

// Sign-in: username + database, as in the production entry tool. Everything
// after this needs the token it returns.
router.post('/auth/login', async (req, res) => {
	const body = parse(loginBody, req.body);
	res.json(await login(body));
});

router.use(authenticate);

router.get('/session', (req, res) => {
	const { site, companyId, erpUserId, user } = req.issueTool;
	res.json({
		user,
		site,
		companyId,
		erpUserId,
		canPost: Boolean(erpUserId),
		writesEnabled: writesEnabled(),
		today: todayInKolkata(),
	});
});

router.get('/picklists', async (req, res) => {
	const q = parse(picklistsQuery, req.query);
	res.json(await listPicklistLines({ ...ctx(req), ...q }));
});

router.post('/picklists/:picklistDetailId/close', requireErpUser, async (req, res) => {
	const { picklistDetailId } = parse(picklistDetailIdParam, req.params);
	res.json(await closePicklistLine({ ...ctx(req), erpUserId: req.issueTool.erpUserId, picklistDetailId }));
});

router.get('/job-contents', async (req, res) => {
	const q = parse(jobContentsQuery, req.query);
	res.json(await searchJobContents({ ...ctx(req), ...q }));
});

router.get('/items', async (req, res) => {
	const q = parse(itemsQuery, req.query);
	res.json(await searchItems({ ...ctx(req), ...q }));
});

router.get('/items/:itemId/batches', async (req, res) => {
	const { itemId } = parse(itemIdParam, req.params);
	res.json(await itemBatches({ ...ctx(req), itemId }));
});

router.get('/lookups/floor-warehouses', async (req, res) => {
	res.json(await floorWarehouses(ctx(req)));
});

router.get('/lookups/departments', async (req, res) => {
	res.json(await departments(ctx(req)));
});

router.get('/lookups/clients', async (req, res) => {
	res.json(await clients(ctx(req)));
});

router.get('/lookups/sales-persons', async (req, res) => {
	res.json(await salesPersons(ctx(req)));
});

router.post('/issues', requireErpUser, async (req, res) => {
	const body = parse(postIssueBody, req.body);
	res.json(await postIssue({ ...ctx(req), erpUserId: req.issueTool.erpUserId, body }));
});

router.get('/issues', async (req, res) => {
	const q = parse(issuesQuery, req.query);
	const to = q.to ?? todayInKolkata();
	const from = q.from ?? addDays(to, -RECENT_ISSUES_DEFAULT_DAYS);
	if (from > to) throw new ApiError(400, 'VALIDATION_FAILED', '"from" must not be after "to".');
	if (daysBetween(from, to) > RECENT_ISSUES_MAX_DAYS) {
		throw new ApiError(400, 'VALIDATION_FAILED', `Pick a range of at most ${RECENT_ISSUES_MAX_DAYS} days.`);
	}
	res.json(await recentIssues({ ...ctx(req), from, to }));
});

router.post('/issues/:id/delete', requireErpUser, async (req, res) => {
	const { id } = parse(issueIdParam, req.params);
	res.json(await deleteIssue({ ...ctx(req), erpUserId: req.issueTool.erpUserId, transactionId: id }));
});

router.post('/issues/:id/refresh-stock', async (req, res) => {
	const { id } = parse(issueIdParam, req.params);
	res.json(await retryStockRefresh({ ...ctx(req), transactionId: id }));
});

router.use(errorHandler);

function ctx(req) {
	return { site: req.issueTool.site, companyId: req.issueTool.companyId };
}

export default router;

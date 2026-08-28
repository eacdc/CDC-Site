import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import mongoose from 'mongoose';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import routes from './routes.js';
import pendingRoutes from './routes-pending.js';
import pendingUpdateRoutes from './routes-pending-update.js';
import prepressPendingRoutes from './routes-prepress-pending.js';
import jobCardRoutes from './routes-job-card.js';
import jobCardCompareRoutes from './routes-job-card-compare.js';
import poProductMatchRoutes from './routes-po-product-match.js';
import googleSheetRoutes from './routes-google-sheet.js';
import scheduleRoutes from './routes-schedule.js';
import rawQcRoutes from './routes-raw-qc.js';
import shipmentEtaRoutes from './routes-shipment-eta.js';
import concernPersonRoutes from './routes-concern-person.js';
import previousItemsByClientRoutes from './routes-previous-items-by-client.js';
import jobProductImageRoutes from './routes-job-product-image.js';
import jobWiseProfitabilityRoutes from './routes-job-wise-profitability.js';
import fgQcRoutes from './routes-fg-qc.js';
import pendingDashboardRoutes from './routes-pending-dashboard.js';
import purchaseBillsRoutes from './routes-purchase-bills.js';
import cdcBillsAuthRoutes from './routes-cdc-bills-auth.js';
import supplierPortalRoutes from './supplier-portal/routes/index.js';
import { scheduleJobs as scheduleSupplierPortalJobs } from './supplier-portal/jobs/index.js';
import { closeSupplierPortal } from './supplier-portal/db/mongo.js';
import { closeWritePools as closeSupplierPortalWritePools } from './supplier-portal/db/mssql.js';
import { closeAllPools } from './db.js';
import { closeVoiceNotesConnection } from './db-voice-notes.js';
import { closePurchaseBillsMongo } from './db-purchase-bills.js';

// Create require function for CommonJS modules
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const app = express();
const port = process.env.PORT || 3001;

// Enable CORS for all routes, including file:// (Origin: null) and
// Chrome Private Network Access preflights to localhost.
app.use((req, res, next) => {
	res.setHeader('Access-Control-Allow-Private-Network', 'true');
	next();
});
app.use(cors({
	origin: (origin, callback) => {
		if (!origin || origin === 'null') {
			return callback(null, '*');
		}
		return callback(null, origin);
	},
	credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Simple console request logger for visibility
app.use((req, res, next) => {
	const start = Date.now();
	console.log(`[REQ] ${req.method} ${req.originalUrl}`);
	res.on('finish', () => {
		const ms = Date.now() - start;
		console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
	});
	next();
});
// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/contractor-po-system';

mongoose.connect(MONGODB_URI)
	.then(async () => {
		console.log('✅ Connected to MongoDB');
		// Drop the stale 'label_1' unique index from AdhocWorkOrders if it still exists
		// (leftover from when the unique field was called 'label' before being renamed to 'adhocId')
		try {
			const col = mongoose.connection.collection('AdhocWorkOrders');
			const indexes = await col.indexes();
			const stale = indexes.find(idx => idx.name === 'label_1');
			if (stale) {
				await col.dropIndex('label_1');
				console.log('✅ Dropped stale label_1 index from AdhocWorkOrders');
			}
		} catch (idxErr) {
			console.warn('⚠️  Could not clean up AdhocWorkOrders indexes:', idxErr.message);
		}
	})
	.catch((error) => {
		console.error('❌ MongoDB connection error:', error);
		// Don't exit, let it retry - MongoDB features will retry when needed
	});

app.use('/api', routes);
app.use('/api', pendingRoutes);
app.use('/api', pendingUpdateRoutes);
app.use('/api', prepressPendingRoutes);
app.use('/api', jobCardRoutes);
app.use('/api', jobCardCompareRoutes);
app.use('/api', poProductMatchRoutes);
app.use('/api', googleSheetRoutes);
app.use('/api', scheduleRoutes);
app.use('/api', rawQcRoutes);
app.use('/api', shipmentEtaRoutes);
app.use('/api', concernPersonRoutes);
app.use('/api', previousItemsByClientRoutes);
app.use('/api', jobProductImageRoutes);
app.use('/api', jobWiseProfitabilityRoutes);
app.use('/api', fgQcRoutes);
app.use('/api', pendingDashboardRoutes);

const fgQcDir = join(__dirname, '..', '..', 'FG Transaction QC');
app.use('/fg-qc', express.static(fgQcDir));

const pendingDashboardDir = join(__dirname, '..', '..', 'Pending Dashboard');
app.use('/pending-dashboard', express.static(pendingDashboardDir));

// CDC Bills Digitization Platform
app.use('/api/cdc-bills/auth', cdcBillsAuthRoutes);
app.use('/api/purchase-bills', purchaseBillsRoutes);

// CDC Supplier Portal — rate capture, matching, comparison, PO check, receiving.
// Self-contained under its own prefix, with its own Mongo connection
// (MONGODB_URI_SupplierPortal) and its own site-scoped MSSQL access.
app.use('/api/supplier-portal', supplierPortalRoutes);

// Contractor PO System routes (loaded as CommonJS via createRequire)
// Keep Contractor PO under a dedicated prefix to avoid collisions with shared /api routes.
app.use('/api/contractor-po/auth',        require('./contractor-po/routes/auth.js'));
app.use('/api/contractor-po/jobs',        require('./contractor-po/routes/jobs.js'));
app.use('/api/contractor-po/operations',  require('./contractor-po/routes/operations.js'));
app.use('/api/contractor-po/work',        require('./contractor-po/routes/work.js'));
app.use('/api/contractor-po/contractors', require('./contractor-po/routes/contractors.js'));
app.use('/api/contractor-po/bills',       require('./contractor-po/routes/bills.js'));
app.use('/api/contractor-po/series',      require('./contractor-po/routes/series.js'));

// Legacy mounts retained for backward compatibility.
app.use('/api/auth',        require('./contractor-po/routes/auth.js'));
app.use('/api/jobs',        require('./contractor-po/routes/jobs.js'));
app.use('/api/operations',  require('./contractor-po/routes/operations.js'));
app.use('/api/work',        require('./contractor-po/routes/work.js'));
app.use('/api/contractors', require('./contractor-po/routes/contractors.js'));
app.use('/api/bills',       require('./contractor-po/routes/bills.js'));
app.use('/api/series',      require('./contractor-po/routes/series.js'));

app.get('/health', (req, res) => {
	res.json({ status: 'ok' });
});

const server = app.listen(port, () => {
	console.log(`Server running on port ${port}`);
	// The delivery-date snapshot cannot be reconstructed after the fact — the
	// ERP edits ExpectedDeliveryDate in place — so it starts with the server.
	scheduleSupplierPortalJobs();
});

// Graceful shutdown
process.on('SIGINT', async () => {
	console.log('Received SIGINT, shutting down gracefully...');
	await closeAllPools();
	await closeVoiceNotesConnection();
	await closePurchaseBillsMongo();
	await closeSupplierPortalWritePools();
	await closeSupplierPortal();
	await mongoose.connection.close();
	server.close(() => {
		console.log('Server closed');
		process.exit(0);
	});
});

process.on('SIGTERM', async () => {
	console.log('Received SIGTERM, shutting down gracefully...');
	await closeAllPools();
	await closeVoiceNotesConnection();
	await closePurchaseBillsMongo();
	await closeSupplierPortalWritePools();
	await closeSupplierPortal();
	await mongoose.connection.close();
	server.close(() => {
		console.log('Server closed');
		process.exit(0);
	});
});

process.on('unhandledRejection', (reason) => {
	console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
	console.error('Uncaught exception:', error);
});



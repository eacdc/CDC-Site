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
import { closeAllPools } from './db.js';
import { closeVoiceNotesConnection } from './db-voice-notes.js';

dotenv.config();

// Create require function for CommonJS modules
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;

// Enable CORS for all routes
app.use(cors({
	origin: true, // Allow all origins for development
	credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Simple console request logger for visibility
app.use((req, res, next) => {
	const start = Date.now();
	//console.log(`[REQ] ${req.method} ${req.originalUrl}`);
	res.on('finish', () => {
		const ms = Date.now() - start;
		//console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
	});
	next();
});
// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/contractor-po-system';

mongoose.connect(MONGODB_URI)
	.then(() => {
		console.log('✅ Connected to MongoDB');
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

// Contractor PO System routes (loaded as CommonJS via createRequire)
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
});

// Graceful shutdown
process.on('SIGINT', async () => {
	console.log('Received SIGINT, shutting down gracefully...');
	await closeAllPools();
	await closeVoiceNotesConnection();
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
	await mongoose.connection.close();
	server.close(() => {
		console.log('Server closed');
		process.exit(0);
	});
});



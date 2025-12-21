import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import mongoose from 'mongoose';
import routes from './routes.js';
import { closeAllPools } from './db.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Enable CORS for all routes
app.use(cors({
	origin: true, // Allow all origins for development
	credentials: true
}));

app.use(express.json());
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
	await mongoose.connection.close();
	server.close(() => {
		console.log('Server closed');
		process.exit(0);
	});
});

process.on('SIGTERM', async () => {
	console.log('Received SIGTERM, shutting down gracefully...');
	await closeAllPools();
	await mongoose.connection.close();
	server.close(() => {
		console.log('Server closed');
		process.exit(0);
	});
});



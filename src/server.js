import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import routes from './routes.js';

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
	console.log(`[REQ] ${req.method} ${req.originalUrl}`);
	res.on('finish', () => {
		const ms = Date.now() - start;
		console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
	});
	next();
});
app.use('/api', routes);

app.get('/health', (req, res) => {
	res.json({ status: 'ok' });
});

app.listen(port, () => {
	console.log(`Server running on port ${port}`);
});



import { Router } from 'express';
import { getPool, sql } from './db.js';
import multer from 'multer';
import QrCode from 'qrcode-reader';
import * as jimp from 'jimp';
const { Jimp } = jimp;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();

// Configure multer for file uploads
const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: 5 * 1024 * 1024, // 5MB limit
	},
	fileFilter: (req, file, cb) => {
		try {
			// Some Android pickers/cameras send "application/octet-stream" or omit mimetype.
			// Allow clear image mimetypes or unknown types and let Jimp validate later.
			const type = (file.mimetype || '').toLowerCase();
			const looksLikeImage = type.startsWith('image/');
			const isUnknown = type === '' || type === 'application/octet-stream';
			if (looksLikeImage || isUnknown) {
				return cb(null, true);
			}
			return cb(new Error('Only image files are allowed'), false);
		} catch (e) {
			return cb(new Error('Only image files are allowed'), false);
		}
	}
});

// ---- Simple file logger for QR endpoints ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logsDir = path.join(__dirname, '..', 'logs');
const qrLogFile = path.join(logsDir, 'qr.log');
const processStartLogFile = path.join(logsDir, 'process-start.log');
const authLogFile = path.join(logsDir, 'auth.log');

function ensureLogsDir() {
	try {
		if (!fs.existsSync(logsDir)) {
			fs.mkdirSync(logsDir, { recursive: true });
		}
	} catch (e) {
		// Best effort; don't crash the app on logging failure
		console.error('Failed to create logs directory:', e);
	}
}

function logQr(message, extra = {}) {
	try {
		ensureLogsDir();
		const timestamp = new Date().toISOString();
		const entry = {
			ts: timestamp,
			message,
			...extra,
		};
		fs.appendFileSync(qrLogFile, JSON.stringify(entry) + '\n');
	} catch (e) {
		console.error('Failed to write QR log entry:', e);
	}
}

function logProcessStart(message, extra = {}) {
    try {
        ensureLogsDir();
        const timestamp = new Date().toISOString();
        const entry = {
            ts: timestamp,
            message,
            ...extra,
        };
        fs.appendFileSync(processStartLogFile, JSON.stringify(entry) + '\n');
    } catch (e) {
        console.error('Failed to write process-start log entry:', e);
    }
}

function logAuth(message, extra = {}) {
    try {
        ensureLogsDir();
        const timestamp = new Date().toISOString();
        const entry = {
            ts: timestamp,
            message,
            ...extra,
        };
        fs.appendFileSync(authLogFile, JSON.stringify(entry) + '\n');
    } catch (e) {
        console.error('Failed to write auth log entry:', e);
    }
}

// Helper function to check if result contains only Status column
function _checkStatusOnlyResponse(recordset) {
    if (!Array.isArray(recordset) || recordset.length === 0) {
        return null;
    }
    
    const firstRow = recordset[0];
    const columns = Object.keys(firstRow);
    
    // Check if there's only one column and it's named "Status" (case insensitive)
    if (columns.length === 1) {
        const columnName = columns[0];
        if (columnName.toLowerCase() === 'status') {
            return {
                message: `Status: ${firstRow[columnName]}`,
                statusValue: firstRow[columnName]
            };
        }
    }
    
    return null;
}

router.get('/auth/login', async (req, res) => {
	try {
		const { username, database } = req.query || {};
        logAuth('Login request received', { route: '/auth/login', ip: req.ip, rawQuery: req.query });
		if (!username || username.trim() === '') {
            logAuth('Login rejected - missing username', { route: '/auth/login' });
			return res.status(400).json({ status: false, error: 'Missing username' });
		}

		const trimmedUsername = username.trim();
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            logAuth('Login rejected - invalid database', { database });
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }
        logAuth('Login params normalized', { username: trimmedUsername, databaseParam: database ?? null, selectedDatabase });

	console.log(`Login attempt - Username: ${trimmedUsername}, Database: ${selectedDatabase}`);
        logAuth('Attempting to get DB pool', { selectedDatabase });

	const pool = await getPool(selectedDatabase);
        logAuth('DB pool acquired', { selectedDatabase });

        // Ensure pool is fully connected and ready before proceeding
        if (!pool.connected) {
            console.warn(`[AUTH] Pool not connected yet, waiting...`);
            // Wait a bit for pool to be ready
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Check again
            if (!pool.connected) {
                logAuth('Pool connection failed', { selectedDatabase });
                return res.status(500).json({ 
                    status: false, 
                    error: 'Database connection not ready. Please try again.' 
                });
            }
        }
        
        // Verify pool is healthy with a quick test query
        try {
            await pool.request().query('SELECT 1 AS test');
            console.log(`[AUTH] Pool verified as healthy for ${selectedDatabase}`);
        } catch (verifyErr) {
            console.error(`[AUTH] Pool health verification failed:`, verifyErr);
            return res.status(500).json({ 
                status: false, 
                error: 'Database connection error. Please try again.' 
            });
        }

        // Diagnostics: verify actual DB context and SP existence
        let currentDb = null;
        let getMachinesForUserExists = null;
        try {
            const dbInfo = await pool.request().query("SELECT DB_NAME() AS currentDb");
            currentDb = dbInfo?.recordset?.[0]?.currentDb || null;
            const spCheck = await pool.request().query("SELECT OBJECT_ID('dbo.GetMachinesForUser') AS spId");
            const spId = spCheck?.recordset?.[0]?.spId || null;
            getMachinesForUserExists = !!spId;
            logAuth('Diagnostics - DB and SP availability', { selectedDatabase, currentDb, getMachinesForUserExists, spId });
            
            // Check if required stored procedure exists
            if (!spId) {
                logAuth('Required stored procedure missing', { selectedDatabase, currentDb, missingProcedure: 'dbo.GetMachinesForUser' });
                return res.status(500).json({ 
                    status: false, 
                    error: `Database ${selectedDatabase} is not properly configured. Missing required stored procedure: dbo.GetMachinesForUser` 
                });
            }
        } catch (diagErr) {
            logAuth('Diagnostics failed', { selectedDatabase, error: String(diagErr) });
        }
        
	const result = await pool.request()
		.input('UserName', sql.NVarChar(255), trimmedUsername)
		.execute('dbo.GetMachinesForUser');

	// Enhanced logging to debug empty results
        console.log('[AUTH] Stored procedure executed', {
            database: selectedDatabase,
            username: trimmedUsername,
            actualDb: currentDb,
            rowCount: result.recordset?.length || 0
        });
        
        if (result.recordset.length > 0) {
            console.log('[AUTH] First row columns:', Object.keys(result.recordset[0]));
            console.log('[AUTH] First row data:', result.recordset[0]);
        } else {
            console.warn('[AUTH] No rows returned from GetMachinesForUser', {
                username: trimmedUsername,
                database: selectedDatabase,
                actualDb: currentDb
            });
        }

        logAuth('Login SP executed', {
            storedProcedure: 'dbo.GetMachinesForUser',
            selectedDatabase,
            resultRowCount: Array.isArray(result.recordset) ? result.recordset.length : 0,
            resultColumns: result.recordset && result.recordset.length > 0 ? Object.keys(result.recordset[0]) : []
        });

		const machines = result.recordset.map(r => ({
			machineId: r.machineid,
			machineName: r.machinename,
			departmentId: r.departmentid,
			productUnitId: r.productunitid
		}));
		if (machines.length === 0) {
            logAuth('Login completed - no machines for user', { selectedDatabase, username: trimmedUsername, currentDb, getMachinesForUserExists });
            return res.json({ status: false, error: 'No machines found for this user in selected database', selectedDatabase, currentDb });
		}

		// Attempt to read userId and ledgerId from first row if provided by SP
		const first = result.recordset[0] || {};
		const userId = first.UserID ?? first.userid ?? first.userId ?? null;
		const ledgerId = first.LedgerID ?? first.ledgerid ?? first.ledgerID ?? null;
        logAuth('Login success', { selectedDatabase, username: trimmedUsername, userId, ledgerId, machinesCount: machines.length, currentDb });
        return res.json({ status: true, userId, ledgerId, machines, selectedDatabase, currentDb });
	} catch (err) {
		console.error('DB login error:', err);
        logAuth('Login failed', { route: '/auth/login', ip: req.ip, error: String(err), stack: err?.stack });
		return res.status(500).json({ status: false, error: 'Internal server error' });
	}
});

// Logout endpoint to clear session/cookies
router.post('/auth/logout', async (req, res) => {
	try {
		logAuth('Logout request received', { route: '/auth/logout', ip: req.ip });
		
		// Clear any session data if using express-session
		if (req.session) {
			req.session.destroy((err) => {
				if (err) {
					console.error('Session destroy error:', err);
					logAuth('Logout - session destroy failed', { error: String(err) });
				}
			});
		}
		
		// Clear cookies
		res.clearCookie('connect.sid'); // Default express-session cookie name
		res.clearCookie('session'); // Alternative session cookie name
		
		logAuth('Logout successful', { route: '/auth/logout', ip: req.ip });
		return res.json({ status: true, message: 'Logged out successfully' });
	} catch (err) {
		console.error('Logout error:', err);
		logAuth('Logout failed', { route: '/auth/logout', ip: req.ip, error: String(err) });
		return res.status(500).json({ status: false, error: 'Logout failed' });
	}
});

router.get('/processes/pending', async (req, res) => {
	try {
		const { MachineID, jobcardcontentno, UserID, isManualEntry, database } = req.query || {};
		const machineIdNum = Number(MachineID);
		const userIdNum = Number(UserID);
		const isManualEntryMode = isManualEntry === 'true';
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }
		
		if (!Number.isInteger(machineIdNum)) {
			return res.status(400).json({ status: false, error: 'MachineID must be an integer' });
		}
		if (!Number.isInteger(userIdNum)) {
			return res.status(400).json({ status: false, error: 'UserID must be an integer' });
		}
		if (!jobcardcontentno || jobcardcontentno.trim() === '') {
			return res.status(400).json({ status: false, error: 'Missing jobcardcontentno' });
		}

		const trimmedJobCardContentNo = jobcardcontentno.trim();

		const pool = await getPool(selectedDatabase);
		let result;
		
		if (isManualEntryMode) {
			// Two-step process for manual entry:
			// 1. First, find job card numbers that match the partial input
			const jobCardSearchResult = await pool.request()
				.input('NumberPart', sql.NVarChar(255), trimmedJobCardContentNo)
				.execute('dbo.FindJobCardsByPartialNumber');
			
			if (jobCardSearchResult.recordset.length === 0) {
				return res.json({ status: false, error: 'No job cards found matching the partial number' });
			}
			
			// 2. Collect processes from all matching job card numbers
			let allProcesses = [];
			
			for (const jobCardRow of jobCardSearchResult.recordset) {
				// Try different possible column names for the job card content number
				const jobCardNumber = jobCardRow.JobCardContentNo || 
									  jobCardRow.jobcardcontentno ||
									  jobCardRow.JobCardNumber ||
									  jobCardRow.Number ||
									  jobCardRow.JobCardNo ||
									  jobCardRow.jobcardno;
				
				if (jobCardNumber) {
					try {
						// Search for processes using this job card number
						const processResult = await pool.request()
							.input('UserID', sql.Int, userIdNum)
							.input('MachineID', sql.Int, machineIdNum)
							.input('JobCardContentNo', sql.NVarChar(255), jobCardNumber.toString())
							.execute('dbo.GetPendingProcesses_ForMachineAndContent');
						
						// Add processes from this job card to our collection
						if (processResult.recordset && processResult.recordset.length > 0) {
							allProcesses = allProcesses.concat(processResult.recordset);
						}
					} catch (processErr) {
						// Log error but continue with other job cards
						console.error(`Error fetching processes for job card ${jobCardNumber}:`, processErr);
					}
				}
			}
			
			// Create a result object with all collected processes
			result = { recordset: allProcesses };
		} else {
			// Use original stored procedure for QR code scanning
			result = await pool.request()
				.input('UserID', sql.Int, userIdNum)
				.input('MachineID', sql.Int, machineIdNum)
				.input('JobCardContentNo', sql.NVarChar(255), trimmedJobCardContentNo)
				.execute('dbo.GetPendingProcesses_ForMachineAndContent');
		}

		// Debug: Log the first row to see available columns
		if (result.recordset.length > 0) {
			//console.log('[DEBUG] First process row columns:', Object.keys(result.recordset[0]));
			//console.log('[DEBUG] First process row data:', result.recordset[0]);
		}

		const processes = result.recordset.map(r => ({
			pwoNo: r.PWOno,
			pwoDate: r.PWODate,
			client: r.Client,
			jobName: r.JobName,
			componentName: r.ComponentName ?? r.COmponentname,
			formNo: r.FormNo,
			scheduleQty: r.ScheduleQty,
			qtyProduced: r.QtyProduced,
			paperIssuedQty: r.PaperIssuedQty ?? null,
			currentStatus: r.CurrentStatus ?? null,
			jobcardContentNo: r.JobCardContentNo ?? r.jobcardcontentno,
			jobBookingJobcardContentsId: parseInt(r.JobBookingJobCardContentsID) || 0,
			processName: r.ProcessName,
			processId: parseInt(r.ProcessID) || 0
		}));

		if (processes.length === 0) {
			return res.json({ status: false });
		}
		return res.json({ status: true, processes });
	} catch (err) {
		console.error('Pending processes error:', err);
		return res.status(500).json({ status: false, error: 'Internal server error' });
	}
});

router.post('/processes/start', async (req, res) => {
    try {
        // Log raw incoming payload for traceability
        //console.log('[START] /api/processes/start called with body:', req.body);
        logProcessStart('Start process called', { route: '/processes/start', ip: req.ip, body: req.body });

        const { UserID, EmployeeID, ProcessID, JobBookingJobCardContentsID, MachineID, JobCardFormNo, database } = req.body || {};

        const userIdNum = Number(UserID);
        const employeeIdNum = Number(EmployeeID);
        const processIdNum = Number(ProcessID);
        const jobBookingIdNum = Number(JobBookingJobCardContentsID);
        const machineIdNum = Number(MachineID);
        const jobCardFormNoStr = (JobCardFormNo || '').toString().trim();
        const selectedDatabase = database || 'KOL'; // Default to KOL

        if (!Number.isInteger(userIdNum)) {
            return res.status(400).json({ status: false, error: 'UserID must be an integer' });
        }
        if (!Number.isInteger(employeeIdNum)) {
            return res.status(400).json({ status: false, error: 'EmployeeID must be an integer' });
        }
        if (!Number.isInteger(processIdNum)) {
            return res.status(400).json({ status: false, error: 'ProcessID must be an integer' });
        }
        if (!Number.isInteger(jobBookingIdNum)) {
            return res.status(400).json({ status: false, error: 'JobBookingJobCardContentsID must be an integer' });
        }
        if (!Number.isInteger(machineIdNum)) {
            return res.status(400).json({ status: false, error: 'MachineID must be an integer' });
        }
        if (!jobCardFormNoStr) {
            return res.status(400).json({ status: false, error: 'JobCardFormNo is required' });
        }

        // Log normalized parameters after basic coercion
        logProcessStart('Normalized start params', {
            route: '/processes/start',
            ip: req.ip,
            normalized: {
                UserID: userIdNum,
                EmployeeID: employeeIdNum,
                ProcessID: processIdNum,
                JobBookingJobCardContentsID: jobBookingIdNum,
                MachineID: machineIdNum,
                JobCardFormNo: jobCardFormNoStr
            }
        });

        const pool = await getPool(selectedDatabase);
        
        // Log query execution details
        logProcessStart('Executing Production_Start_Manu stored procedure', {
            route: '/processes/start',
            ip: req.ip,
            storedProcedure: 'dbo.Production_Start_Manu',
            parameters: {
                UserID: userIdNum,
                EmployeeID: employeeIdNum,
                ProcessID: processIdNum,
                JobBookingJobCardContentsID: jobBookingIdNum,
                MachineID: machineIdNum,
                JobCardFormNo: jobCardFormNoStr
            }
        });

        const result = await pool.request()
            .input('UserID', sql.Int, userIdNum)
            .input('EmployeeID', sql.Int, employeeIdNum)
            .input('ProcessID', sql.Int, processIdNum)
            .input('JobBookingJobCardContentsID', sql.Int, jobBookingIdNum)
            .input('MachineID', sql.Int, machineIdNum)
            .input('JobCardFormNo', sql.NVarChar(255), jobCardFormNoStr)
            .execute('dbo.Production_Start_Manu');

        // Log detailed query results
        logProcessStart('Start process query completed', {
            route: '/processes/start',
            ip: req.ip,
            storedProcedure: 'dbo.Production_Start_Manu',
            resultRowCount: Array.isArray(result.recordset) ? result.recordset.length : 0,
            resultColumns: result.recordset && result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [],
            resultData: result.recordset || [],
            returnValue: result.returnValue,
            rowsAffected: result.rowsAffected
        });
        
        // Check if result contains only Status column
        const statusWarning = _checkStatusOnlyResponse(result.recordset);
        if (statusWarning) {
            logProcessStart('Status warning detected in start process', {
                route: '/processes/start',
                ip: req.ip,
                statusWarning: statusWarning,
                storedProcedure: 'dbo.Production_Start_Manu'
            });
            return res.json({ 
                status: true, 
                result: result.recordset || [],
                statusWarning: statusWarning
            });
        }
        
        return res.json({ status: true, result: result.recordset || [] });
    } catch (err) {
        console.error('Start process error:', err);
        logProcessStart('Start process failed', { route: '/processes/start', ip: req.ip, error: String(err) });
        return res.status(500).json({ status: false, error: 'Internal server error' });
    }
});

// QR Code processing endpoint
router.post('/qr/process', upload.single('qrImage'), async (req, res) => {
	try {
		if (!req.file) {
			logQr('No image provided to /qr/process', { route: '/qr/process', ip: req.ip });
			return res.status(400).json({ 
				status: false, 
				error: 'No image file provided' 
			});
		}

		// Process the uploaded image with Jimp
		let image;
		try {
			image = await Jimp.read(req.file.buffer);
		} catch (e) {
			logQr('Failed to read image with Jimp', { error: String(e) });
			return res.status(400).json({ status: false, error: 'Invalid image file' });
		}
		
		// Create QR code reader
		const qr = new QrCode();
		
		// Convert image to format that qrcode-reader can process
		const imageData = {
			data: new Uint8ClampedArray(image.bitmap.data),
			width: image.bitmap.width,
			height: image.bitmap.height
		};

		// Process QR code
		const qrResult = await new Promise((resolve, reject) => {
			qr.callback = (err, value) => {
				if (err) {
					reject(err);
				} else {
					resolve(value);
				}
			};
			qr.decode(imageData);
		});

		if (qrResult && qrResult.result) {
			logQr('QR decoded successfully', { route: '/qr/process' });
			return res.json({ 
				status: true, 
				jobCardContentNo: qrResult.result.trim()
			});
		} else {
			logQr('No QR code found in image', { route: '/qr/process' });
			return res.json({ 
				status: false, 
				error: 'No QR code found in the image' 
			});
		}

	} catch (err) {
		console.error('QR processing error:', err);
		logQr('Unhandled error in /qr/process', { error: String(err), stack: err?.stack });
		return res.status(500).json({ 
			status: false, 
			error: 'Failed to process QR code' 
		});
	}
});

// QR Code processing endpoint for base64 data (for camera captures)
router.post('/qr/process-base64', async (req, res) => {
	try {
		const { imageData } = req.body;
		
		if (!imageData) {
			logQr('No imageData provided to /qr/process-base64', { route: '/qr/process-base64', ip: req.ip });
			return res.status(400).json({ 
				status: false, 
				error: 'No image data provided' 
			});
		}

		// Remove data URL prefix if present
		const base64Data = imageData.replace(/^data:image\/[a-z]+;base64,/, '');
		const buffer = Buffer.from(base64Data, 'base64');

		// Process the image with Jimp
		let image;
		try {
			image = await Jimp.read(buffer);
		} catch (e) {
			logQr('Failed to read base64 image with Jimp', { error: String(e) });
			return res.status(400).json({ status: false, error: 'Invalid image data' });
		}
		
		// Create QR code reader
		const qr = new QrCode();
		
		// Convert image to format that qrcode-reader can process
		const imageDataObj = {
			data: new Uint8ClampedArray(image.bitmap.data),
			width: image.bitmap.width,
			height: image.bitmap.height
		};

		// Process QR code
		const qrResult = await new Promise((resolve, reject) => {
			qr.callback = (err, value) => {
				if (err) {
					reject(err);
				} else {
					resolve(value);
				}
			};
			qr.decode(imageDataObj);
		});

		if (qrResult && qrResult.result) {
			logQr('QR decoded successfully (base64)', { route: '/qr/process-base64' });
			return res.json({ 
				status: true, 
				jobCardContentNo: qrResult.result.trim()
			});
		} else {
			logQr('No QR code found in base64 image', { route: '/qr/process-base64' });
			return res.json({ 
				status: false, 
				error: 'No QR code found in the image' 
			});
		}

	} catch (err) {
		console.error('QR processing error:', err);
		logQr('Unhandled error in /qr/process-base64', { error: String(err), stack: err?.stack });
		return res.status(500).json({ 
			status: false, 
			error: 'Failed to process QR code' 
		});
	}
});

// Complete production endpoint
router.post('/processes/complete', async (req, res) => {
    try {
        //console.log('[COMPLETE] /api/processes/complete called with body:', req.body);
        logProcessStart('Complete process called', { route: '/processes/complete', ip: req.ip, body: req.body });

        const { UserID, EmployeeID, ProcessID, JobBookingJobCardContentsID, MachineID, JobCardFormNo, ProductionQty, WastageQty, database } = req.body || {};

        const userIdNum = Number(UserID);
        const employeeIdNum = Number(EmployeeID);
        const processIdNum = Number(ProcessID);
        const jobBookingIdNum = Number(JobBookingJobCardContentsID);
        const machineIdNum = Number(MachineID);
        const jobCardFormNoStr = (JobCardFormNo || '').toString().trim();
        const productionQtyNum = Number(ProductionQty);
        const wastageQtyNum = Number(WastageQty);
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        if (!Number.isInteger(userIdNum)) {
            return res.status(400).json({ status: false, error: 'UserID must be an integer' });
        }
        if (!Number.isInteger(employeeIdNum)) {
            return res.status(400).json({ status: false, error: 'EmployeeID must be an integer' });
        }
        if (!Number.isInteger(processIdNum)) {
            return res.status(400).json({ status: false, error: 'ProcessID must be an integer' });
        }
        if (!Number.isInteger(jobBookingIdNum)) {
            return res.status(400).json({ status: false, error: 'JobBookingJobCardContentsID must be an integer' });
        }
        if (!Number.isInteger(machineIdNum)) {
            return res.status(400).json({ status: false, error: 'MachineID must be an integer' });
        }
        if (!jobCardFormNoStr) {
            return res.status(400).json({ status: false, error: 'JobCardFormNo is required' });
        }
        if (!Number.isInteger(productionQtyNum)) {
            return res.status(400).json({ status: false, error: 'ProductionQty must be an integer' });
        }
        if (!Number.isInteger(wastageQtyNum)) {
            return res.status(400).json({ status: false, error: 'WastageQty must be an integer' });
        }

        logProcessStart('Normalized complete params', {
            route: '/processes/complete',
            ip: req.ip,
            normalized: {
                UserID: userIdNum,
                EmployeeID: employeeIdNum,
                ProcessID: processIdNum,
                JobBookingJobCardContentsID: jobBookingIdNum,
                MachineID: machineIdNum,
                JobCardFormNo: jobCardFormNoStr,
                ProductionQty: productionQtyNum,
                WastageQty: wastageQtyNum
            }
        });

        const pool = await getPool(selectedDatabase);

        // Diagnostics: verify actual DB context and SP existence
        try {
            const dbInfo = await pool.request().query("SELECT DB_NAME() AS currentDb");
            const currentDb = dbInfo?.recordset?.[0]?.currentDb || null;
            const spCheck = await pool.request().query("SELECT OBJECT_ID('dbo.Production_End_Manu') AS spId");
            const spId = spCheck?.recordset?.[0]?.spId || null;
            logProcessStart('Diagnostics - DB and SP availability (complete)', { selectedDatabase, currentDb, productionEndManuExists: !!spId, spId });
        } catch (diagErr) {
            logProcessStart('Diagnostics failed (complete)', { selectedDatabase, error: String(diagErr) });
        }
        
        // Log query execution details
        logProcessStart('Executing Production_End_Manu stored procedure', {
            route: '/processes/complete',
            ip: req.ip,
            storedProcedure: 'dbo.Production_End_Manu',
            parameters: {
                UserID: userIdNum,
                EmployeeID: employeeIdNum,
                ProcessID: processIdNum,
                JobBookingJobCardContentsID: jobBookingIdNum,
                MachineID: machineIdNum,
                JobCardFormNo: jobCardFormNoStr,
                ProductionQty: productionQtyNum,
                WastageQty: wastageQtyNum
            }
        });

        const result = await pool.request()
            .input('UserID', sql.Int, userIdNum)
            .input('EmployeeID', sql.Int, employeeIdNum)
            .input('ProcessID', sql.Int, processIdNum)
            .input('JobBookingJobCardContentsID', sql.Int, jobBookingIdNum)
            .input('MachineID', sql.Int, machineIdNum)
            .input('JobCardFormNo', sql.NVarChar(255), jobCardFormNoStr)
            .input('ProductionQty', sql.Int, productionQtyNum)
            .input('WastageQty', sql.Int, wastageQtyNum)
            .execute('dbo.Production_End_Manu');

        // Log detailed query results
        logProcessStart('Complete process query completed', {
            route: '/processes/complete',
            ip: req.ip,
            storedProcedure: 'dbo.Production_End_Manu',
            resultRowCount: Array.isArray(result.recordset) ? result.recordset.length : 0,
            resultColumns: result.recordset && result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [],
            resultData: result.recordset || [],
            returnValue: result.returnValue,
            rowsAffected: result.rowsAffected
        });
        
        // Check if result contains only Status column
        const statusWarning = _checkStatusOnlyResponse(result.recordset);
        if (statusWarning) {
            logProcessStart('Status warning detected in complete process', {
                route: '/processes/complete',
                ip: req.ip,
                statusWarning: statusWarning,
                storedProcedure: 'dbo.Production_End_Manu'
            });
            return res.json({ 
                status: true, 
                result: result.recordset || [],
                statusWarning: statusWarning
            });
        }
        
        return res.json({ status: true, result: result.recordset || [] });
    } catch (err) {
        console.error('Complete process error:', err);
        logProcessStart('Complete process failed', { route: '/processes/complete', ip: req.ip, error: String(err) });
        return res.status(500).json({ status: false, error: 'Internal server error' });
    }
});

// Cancel production endpoint
router.post('/processes/cancel', async (req, res) => {
    try {
        //console.log('[CANCEL] /api/processes/cancel called with body:', req.body);
        logProcessStart('Cancel process called', { route: '/processes/cancel', ip: req.ip, body: req.body });

        const { UserID, EmployeeID, ProcessID, JobBookingJobCardContentsID, MachineID, JobCardFormNo, database } = req.body || {};

        const userIdNum = Number(UserID);
        const employeeIdNum = Number(EmployeeID);
        const processIdNum = Number(ProcessID);
        const jobBookingIdNum = Number(JobBookingJobCardContentsID);
        const machineIdNum = Number(MachineID);
        const jobCardFormNoStr = (JobCardFormNo || '').toString().trim();
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        if (!Number.isInteger(userIdNum)) {
            return res.status(400).json({ status: false, error: 'UserID must be an integer' });
        }
        if (!Number.isInteger(employeeIdNum)) {
            return res.status(400).json({ status: false, error: 'EmployeeID must be an integer' });
        }
        if (!Number.isInteger(processIdNum)) {
            return res.status(400).json({ status: false, error: 'ProcessID must be an integer' });
        }
        if (!Number.isInteger(jobBookingIdNum)) {
            return res.status(400).json({ status: false, error: 'JobBookingJobCardContentsID must be an integer' });
        }
        if (!Number.isInteger(machineIdNum)) {
            return res.status(400).json({ status: false, error: 'MachineID must be an integer' });
        }
        if (!jobCardFormNoStr) {
            return res.status(400).json({ status: false, error: 'JobCardFormNo is required' });
        }

        logProcessStart('Normalized cancel params', {
            route: '/processes/cancel',
            ip: req.ip,
            normalized: {
                UserID: userIdNum,
                EmployeeID: employeeIdNum,
                ProcessID: processIdNum,
                JobBookingJobCardContentsID: jobBookingIdNum,
                MachineID: machineIdNum,
                JobCardFormNo: jobCardFormNoStr
            }
        });

        const pool = await getPool(selectedDatabase);
        
        // Log query execution details
        logProcessStart('Executing Production_Cancel_Manu stored procedure', {
            route: '/processes/cancel',
            ip: req.ip,
            storedProcedure: 'dbo.Production_Cancel_Manu',
            parameters: {
                UserID: userIdNum,
                EmployeeID: employeeIdNum,
                ProcessID: processIdNum,
                JobBookingJobCardContentsID: jobBookingIdNum,
                MachineID: machineIdNum,
                JobCardFormNo: jobCardFormNoStr
            }
        });

        const result = await pool.request()
            .input('UserID', sql.Int, userIdNum)
            .input('EmployeeID', sql.Int, employeeIdNum)
            .input('ProcessID', sql.Int, processIdNum)
            .input('JobBookingJobCardContentsID', sql.Int, jobBookingIdNum)
            .input('MachineID', sql.Int, machineIdNum)
            .input('JobCardFormNo', sql.NVarChar(255), jobCardFormNoStr)
            .execute('dbo.Production_Cancel_Manu');

        // Log detailed query results
        logProcessStart('Cancel process query completed', {
            route: '/processes/cancel',
            ip: req.ip,
            storedProcedure: 'dbo.Production_Cancel_Manu',
            resultRowCount: Array.isArray(result.recordset) ? result.recordset.length : 0,
            resultColumns: result.recordset && result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [],
            resultData: result.recordset || [],
            returnValue: result.returnValue,
            rowsAffected: result.rowsAffected
        });
        
        // Check if result contains only Status column
        const statusWarning = _checkStatusOnlyResponse(result.recordset);
        if (statusWarning) {
            logProcessStart('Status warning detected in cancel process', {
                route: '/processes/cancel',
                ip: req.ip,
                statusWarning: statusWarning,
                storedProcedure: 'dbo.Production_Cancel_Manu'
            });
            return res.json({ 
                status: true, 
                result: result.recordset || [],
                statusWarning: statusWarning
            });
        }
        
        return res.json({ status: true, result: result.recordset || [] });
    } catch (err) {
        console.error('Cancel process error:', err);
        logProcessStart('Cancel process failed', { route: '/processes/cancel', ip: req.ip, error: String(err) });
        return res.status(500).json({ status: false, error: 'Internal server error' });
    }
});

// Log viewer endpoint for debugging and monitoring
router.get('/logs/process-start', async (req, res) => {
    try {
        const { lines = 50 } = req.query;
        const maxLines = Math.min(parseInt(lines) || 50, 1000); // Limit to 1000 lines max
        
        if (!fs.existsSync(processStartLogFile)) {
            return res.json({ 
                status: true, 
                logs: [], 
                message: 'No log file found' 
            });
        }
        
        const fileContent = fs.readFileSync(processStartLogFile, 'utf8');
        const allLines = fileContent.trim().split('\n').filter(line => line.trim());
        
        // Get the last N lines
        const recentLines = allLines.slice(-maxLines);
        
        // Parse JSON logs
        const parsedLogs = recentLines.map(line => {
            try {
                return JSON.parse(line);
            } catch (e) {
                return { raw: line, parseError: true };
            }
        });
        
        return res.json({
            status: true,
            logs: parsedLogs,
            totalLines: allLines.length,
            displayedLines: parsedLogs.length
        });
    } catch (err) {
        console.error('Error reading process logs:', err);
        return res.status(500).json({ 
            status: false, 
            error: 'Failed to read logs' 
        });
    }
});

// Serve log viewer HTML page
router.get('/logs/viewer', (req, res) => {
    try {
        const logViewerPath = path.join(__dirname, '..', 'log-viewer.html');
        if (fs.existsSync(logViewerPath)) {
            res.sendFile(logViewerPath);
        } else {
            res.status(404).send('Log viewer not found');
        }
    } catch (err) {
        console.error('Error serving log viewer:', err);
        res.status(500).send('Error loading log viewer');
    }
});

// Auth logs endpoint (to inspect login flow)
router.get('/logs/auth', async (req, res) => {
    try {
        const { lines = 200 } = req.query;
        const maxLines = Math.min(parseInt(lines) || 200, 2000);

        if (!fs.existsSync(authLogFile)) {
            return res.json({ status: true, logs: [], message: 'No auth log file found' });
        }

        const fileContent = fs.readFileSync(authLogFile, 'utf8');
        const allLines = fileContent.trim().split('\n').filter(line => line.trim());
        const recentLines = allLines.slice(-maxLines);
        const parsedLogs = recentLines.map(line => {
            try {
                return JSON.parse(line);
            } catch (e) {
                return { raw: line, parseError: true };
            }
        });
        return res.json({ status: true, logs: parsedLogs, totalLines: allLines.length, displayedLines: parsedLogs.length });
    } catch (err) {
        console.error('Error reading auth logs:', err);
        return res.status(500).json({ status: false, error: 'Failed to read auth logs' });
    }
});

// Clear database pool cache endpoint
router.post('/admin/clear-db-cache', async (req, res) => {
    try {
        const { closeAllPools } = await import('./db.js');
        await closeAllPools();
        console.log('[ADMIN] Database pool cache cleared');
        logAuth('Database pool cache cleared', { route: '/admin/clear-db-cache', ip: req.ip });
        return res.json({ status: true, message: 'Database pool cache cleared successfully' });
    } catch (err) {
        console.error('[ADMIN] Error clearing database cache:', err);
        logAuth('Failed to clear database cache', { route: '/admin/clear-db-cache', ip: req.ip, error: String(err) });
        return res.status(500).json({ status: false, error: 'Failed to clear database cache' });
    }
});

// Diagnostic endpoint to check environment variables
router.get('/admin/env-check', (req, res) => {
    try {
        const envInfo = {
            DB_NAME: process.env.DB_NAME || null,
            DB_NAME_KOL: process.env.DB_NAME_KOL || null,
            DB_NAME_AHM: process.env.DB_NAME_AHM || null,
            DB_SERVER: process.env.DB_SERVER || null,
            DB_USER: process.env.DB_USER || null,
            NODE_ENV: process.env.NODE_ENV || null,
            timestamp: new Date().toISOString()
        };
        console.log('[ADMIN] Environment check:', envInfo);
        logAuth('Environment check requested', { route: '/admin/env-check', ip: req.ip, envInfo });
        return res.json({ status: true, environment: envInfo });
    } catch (err) {
        console.error('[ADMIN] Error checking environment:', err);
        return res.status(500).json({ status: false, error: 'Failed to check environment' });
    }
});

// GRN: Initiate Challan by Barcode
router.post('/grn/initiate', async (req, res) => {
    try {
        const { barcode, database, userId } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const barcodeNum = Number(barcode);
        if (!Number.isFinite(barcodeNum)) {
            return res.status(400).json({ status: false, error: 'Invalid or missing barcode' });
        }

        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing userId' });
        }

        const pool = await getPool(selectedDatabase);

        const result = await pool.request()
            .input('BarcodeNo', sql.Int, barcodeNum)
            .input('Status', sql.NVarChar(50), 'new-check')
            .input('UserID', sql.Int, userIdNum)
            .execute('dbo.SaveDeliveryNoteByBarcode_Manu');

        // Normalize response
        const rows = result.recordset || [];
        // Try to pick ledger/client name from common columns
        const first = rows[0] || {};
        const ledgerName = first.ledgername || first.LedgerName || first.client || first.Client || null;

        // Handle Fail statuses from SP gracefully
        const statusText = first.Status || first.status || '';
        if (typeof statusText === 'string' && statusText.toLowerCase().startsWith('fail')) {
            return res.json({ status: false, error: statusText });
        }

        return res.json({ status: true, data: rows, ledgerName });
    } catch (err) {
        console.error('GRN initiate error:', err?.message || err);
        return res.status(500).json({ 
            status: false, 
            error: 'Failed to initiate challan',
            details: err?.message || String(err)
        });
    }
});

// GRN: Save Delivery Note
router.post('/grn/save-delivery-note', async (req, res) => {
    try {
        const { barcode, database, userId, clientName, modeOfTransport, containerNumber, sealNumber, transporterName, transporterLedgerId, vehicleNumber } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }

        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing userId' });
        }

        const barcodeNum = Number(barcode);
        if (!Number.isFinite(barcodeNum)) {
            return res.status(400).json({ status: false, error: 'Invalid or missing barcode' });
        }

        // Validate required fields
        if (!clientName || !modeOfTransport || !containerNumber || !sealNumber || !transporterName || !vehicleNumber) {
            return res.status(400).json({ status: false, error: 'All fields are mandatory' });
        }

        const transporterIdNum = Number(transporterLedgerId);
        if (!Number.isInteger(transporterIdNum) || transporterIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing transporterLedgerId' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('BarcodeNo', sql.Int, barcodeNum)
            .input('Status', sql.NVarChar(50), 'new-start')
            .input('UserID', sql.Int, userIdNum)
            .input('TransporterLedgerID', sql.Int, transporterIdNum)
            .input('ModeOfTransport', sql.NVarChar(255), modeOfTransport)
            .input('VehicleNo', sql.NVarChar(255), vehicleNumber)
            .input('ContainerNo', sql.NVarChar(255), containerNumber)
            .input('SealNo', sql.NVarChar(255), sealNumber)
            .execute('dbo.SaveDeliveryNoteByBarcode_Manu');

        const rows = result.recordset || [];
        const first = rows[0] || {};
        const normalized = {
            statusText: first.Status || first.status || null,
            transactionId: first.FGTransactionID || first.fgtransactionid || null,
            voucherNo: first.VoucherNo || first.voucherno || null,
            jobName: first.JobName || first.jobname || null,
            orderQty: first.OrderQty || first.OrderQty || first.orderqty || null,
            gpnQty: first.GPNQty || first.gpnqty || null,
            deliveredThisVoucher: first.DeliveredThisVoucher || first.deliveredthisvoucher || null,
            deliveredTotal: first.DeliveredTotal || first.deliveredtotal || null,
            cartonCount: first.CartonCt || first.cartonct || null
        };

        // Handle known failure from SP (e.g., "Fail: Barcode already dispatched")
        const statusTextLower = (normalized.statusText || '').toString().toLowerCase();
        if (statusTextLower.startsWith('fail')) {
            let msg = normalized.statusText || 'Operation failed';
            if (statusTextLower.includes('barcode already dispatched')) {
                msg = 'Barcode already dispatched';
            }
            return res.json({ status: false, error: msg, sp: normalized });
        }

        return res.json({ 
            status: true,
            deliveryNoteNumber: normalized.voucherNo || '25-26/26',
            data: {
                clientName,
                modeOfTransport,
                containerNumber,
                sealNumber,
                transporterName,
                transporterLedgerId: transporterIdNum,
                vehicleNumber,
                barcode: barcodeNum
            },
            sp: normalized
        });
    } catch (err) {
        console.error('GRN save delivery note error:', err);
        return res.status(500).json({ status: false, error: 'Failed to save delivery note' });
    }
});

// GRN: Update Delivery Note (append line items)
router.post('/grn/update-delivery-note', async (req, res) => {
    try {
        const { barcode, database, userId, fgTransactionId } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }
        const userIdNum = Number(userId);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing userId' });
        }
        const barcodeNum = Number(barcode);
        if (!Number.isFinite(barcodeNum)) {
            return res.status(400).json({ status: false, error: 'Invalid or missing barcode' });
        }
        const fgIdNum = Number(fgTransactionId);
        if (!Number.isInteger(fgIdNum) || fgIdNum <= 0) {
            return res.status(400).json({ status: false, error: 'Invalid or missing FGTransactionID' });
        }

        const pool = await getPool(selectedDatabase);
        const result = await pool.request()
            .input('BarcodeNo', sql.Int, barcodeNum)
            .input('Status', sql.NVarChar(50), 'update')
            .input('UserID', sql.Int, userIdNum)
            .input('FGTransactionID', sql.Int, fgIdNum)
            .execute('dbo.SaveDeliveryNoteByBarcode_Manu');

        const rows = result.recordset || [];
        const first = rows[0] || {};
        const normalized = {
            statusText: first.Status || first.status || null,
            transactionId: first.FGTransactionID || first.fgtransactionid || null,
            voucherNo: first.VoucherNo || first.voucherno || null,
            jobName: first.JobName || first.jobname || null,
            orderQty: first.OrderQty || first.orderqty || null,
            gpnQty: first.GPNQty || first.gpnqty || null,
            deliveredThisVoucher: first.DeliveredThisVoucher || first.deliveredthisvoucher || null,
            deliveredTotal: first.DeliveredTotal || first.deliveredtotal || null,
            cartonCount: first.CartonCt || first.cartonct || null
        };

        // Fail handling
        const statusTextLower = (normalized.statusText || '').toString().toLowerCase();
        if (statusTextLower.startsWith('fail')) {
            return res.json({ status: false, error: normalized.statusText || 'Operation failed', sp: normalized });
        }

        return res.json({ status: true, sp: normalized });
    } catch (err) {
        console.error('GRN update delivery note error:', err);
        return res.status(500).json({ status: false, error: 'Failed to update delivery note' });
    }
});

// GRN: List Transporters for dropdown
router.get('/grn/transporters', async (req, res) => {
    try {
        const { database } = req.query || {};
        const selectedDatabase = (database || '').toUpperCase();
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ status: false, error: 'Invalid or missing database (must be KOL or AHM)' });
        }
        const pool = await getPool(selectedDatabase);
        const result = await pool.request().query("SELECT ledgerid, ledgername FROM ledgermaster WHERE ledgertype LIKE 'trans%' AND ISNULL(IsDeletedTransaction, 0) = 0");
        const rows = (result.recordset || []).map(r => ({
            ledgerId: r.ledgerid,
            ledgerName: r.ledgername
        }));
        return res.json({ status: true, transporters: rows });
    } catch (err) {
        console.error('GRN transporters error:', err);
        return res.status(500).json({ status: false, error: 'Failed to fetch transporters' });
    }
});

// Get latest machine status per machine
router.post('/machine-status/latest', async (req, res) => {
    try {
        const { database } = req.body || {};
        const selectedDatabase = (database || '').toUpperCase();
        
        if (selectedDatabase !== 'KOL' && selectedDatabase !== 'AHM') {
            return res.status(400).json({ 
                status: false, 
                error: 'Invalid or missing database (must be KOL or AHM)' 
            });
        }

        console.log(`[MACHINE-STATUS] Getting latest machine status for database: ${selectedDatabase}`);
        
        const pool = await getPool(selectedDatabase);
        
        // Execute the stored procedure
        const result = await pool.request()
            .execute('GetLatestMachineStatusPerMachine');
        
        console.log(`[MACHINE-STATUS] Query completed. Records found: ${result.recordset?.length || 0}`);
        
        // Log first record for debugging
        if (result.recordset && result.recordset.length > 0) {
            console.log('[MACHINE-STATUS] First record columns:', Object.keys(result.recordset[0]));
            console.log('[MACHINE-STATUS] First record data:', result.recordset[0]);
        }
        
        return res.json({
            status: true,
            data: result.recordset || [],
            message: 'Machine statuses retrieved successfully'
        });
    } catch (error) {
        console.error('[MACHINE-STATUS] Error getting machine statuses:', error);
        return res.status(500).json({
            status: false,
            error: 'Failed to get machine statuses: ' + error.message
        });
    }
});

export default router;



# CDC Process Logging Guide

## Overview

The CDC backend now includes comprehensive logging for all MySQL query operations in the start, complete, and cancel production functionality. This logging system captures detailed information about stored procedure calls, parameters, results, and any status warnings.

## What Gets Logged

### 1. Process Start (`/api/processes/start`)
- **Stored Procedure**: `dbo.Production_Start_Manu`
- **Parameters**: UserID, EmployeeID, ProcessID, JobBookingJobCardContentsID, MachineID, JobCardFormNo
- **Results**: Complete result set, column names, row count, return values
- **Status Warnings**: If query returns only a "Status" column

### 2. Process Complete (`/api/processes/complete`)
- **Stored Procedure**: `dbo.Production_End_Manu`
- **Parameters**: UserID, EmployeeID, ProcessID, JobBookingJobCardContentsID, MachineID, JobCardFormNo, ProductionQty, WastageQty
- **Results**: Complete result set, column names, row count, return values
- **Status Warnings**: If query returns only a "Status" column

### 3. Process Cancel (`/api/processes/cancel`)
- **Stored Procedure**: `dbo.Production_Cancel_Manu`
- **Parameters**: UserID, EmployeeID, ProcessID, JobBookingJobCardContentsID, MachineID, JobCardFormNo
- **Results**: Complete result set, column names, row count, return values
- **Status Warnings**: If query returns only a "Status" column

## Log Format

Each log entry is stored as a JSON object with the following structure:

```json
{
  "ts": "2024-01-15T10:30:45.123Z",
  "message": "Executing Production_Start_Manu stored procedure",
  "route": "/processes/start",
  "ip": "192.168.1.100",
  "storedProcedure": "dbo.Production_Start_Manu",
  "parameters": {
    "UserID": 1,
    "EmployeeID": 123,
    "ProcessID": 456,
    "JobBookingJobCardContentsID": 789,
    "MachineID": 5,
    "JobCardFormNo": "JC001"
  },
  "resultRowCount": 1,
  "resultColumns": ["Status"],
  "resultData": [{"Status": "Process started successfully"}],
  "returnValue": 0,
  "rowsAffected": [1],
  "statusWarning": {
    "message": "Status: Process started successfully",
    "statusValue": "Process started successfully"
  }
}
```

## Log File Location

Logs are stored in: `backend/logs/process-start.log`

## Viewing Logs

### Method 1: Direct File Access
```bash
# View recent logs
tail -f backend/logs/process-start.log

# View last 100 lines
tail -100 backend/logs/process-start.log

# Search for specific operations
grep "Production_Start_Manu" backend/logs/process-start.log
```

### Method 2: API Endpoint
Access logs programmatically via the REST API:

```http
GET /api/logs/process-start?lines=100
```

Response:
```json
{
  "status": true,
  "logs": [...],
  "totalLines": 1250,
  "displayedLines": 100
}
```

### Method 3: Web-Based Log Viewer
Access the interactive log viewer in your browser:

```
http://your-server:port/api/logs/viewer
```

Features:
- Real-time log viewing
- Auto-refresh capability
- Filtering by number of lines
- Syntax highlighting
- Color-coded log levels (success, warning, error)
- Expandable details for each log entry

## Log Analysis

### Finding Status Warnings
Look for log entries with `message` containing "Status warning detected":

```bash
grep "Status warning detected" backend/logs/process-start.log
```

### Monitoring Query Performance
Each query execution is logged with timestamps, allowing you to:
- Track query execution times
- Monitor database performance
- Identify slow operations

### Debugging Failed Operations
Error logs include:
- Full error messages
- Stack traces
- Request parameters
- Client IP addresses

## Log Rotation

The log files will grow over time. Consider implementing log rotation:

```bash
# Manual log rotation
mv backend/logs/process-start.log backend/logs/process-start.log.$(date +%Y%m%d)
touch backend/logs/process-start.log
```

## Security Considerations

- Log files may contain sensitive data (user IDs, process details)
- Ensure proper file permissions on log files
- Consider log retention policies
- Sanitize logs before sharing for debugging

## Example Log Entries

### Successful Process Start
```json
{
  "ts": "2024-01-15T10:30:45.123Z",
  "message": "Start process query completed",
  "route": "/processes/start",
  "storedProcedure": "dbo.Production_Start_Manu",
  "resultRowCount": 1,
  "resultColumns": ["ProcessStartID"],
  "resultData": [{"ProcessStartID": 12345}]
}
```

### Status Warning
```json
{
  "ts": "2024-01-15T10:35:22.456Z",
  "message": "Status warning detected in start process",
  "route": "/processes/start",
  "statusWarning": {
    "message": "Status: Machine is currently in maintenance mode",
    "statusValue": "Machine is currently in maintenance mode"
  }
}
```

### Error Case
```json
{
  "ts": "2024-01-15T10:40:15.789Z",
  "message": "Start process failed",
  "route": "/processes/start",
  "error": "Connection timeout to database server"
}
```

## Monitoring and Alerts

You can set up monitoring by:

1. **Watching for errors**: Monitor log entries with "failed" or "error" messages
2. **Status warnings**: Track entries with `statusWarning` fields
3. **Performance**: Monitor query execution patterns and response times
4. **Usage patterns**: Analyze API usage by IP, user, and time patterns

## Integration with Monitoring Tools

The JSON log format makes it easy to integrate with monitoring tools like:
- ELK Stack (Elasticsearch, Logstash, Kibana)
- Splunk
- Grafana + Loki
- Custom monitoring scripts

Example Logstash configuration:
```ruby
input {
  file {
    path => "/path/to/backend/logs/process-start.log"
    codec => "json"
  }
}
```

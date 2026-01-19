# Testing Guide: Artwork Pending Update API

## Prerequisites

1. **Backend server running**: `npm start` in `backend` folder
2. **Database connections**: Ensure SQL (KOL/AHM) and MongoDB are accessible
3. **Test tool**: Postman, Thunder Client (VS Code), or `curl` command

---

## Step 1: Get Real Data IDs

First, fetch pending data to get valid IDs for testing:

### Get Pending Data
```bash
# Get all pending entries
curl http://localhost:3001/api/artwork/pending

# Or filter by source
curl "http://localhost:3001/api/artwork/pending?source=kol"
curl "http://localhost:3001/api/artwork/pending?source=ahm"
curl "http://localhost:3001/api/artwork/pending?source=mongo"
```

**Response will contain:**
- For SQL: `OrderBookingDetailsID` and `__SourceDB` (KOL_SQL or AMD_SQL)
- For Mongo: `__MongoId` and `__SourceDB` (MONGO_UNORDERED)

**Save these values** - you'll need them for testing!

---

## Step 2: Test SQL Updates (KOL_SQL / AMD_SQL)

### Test Case 1: Update File Status → Auto-stamp FileReceivedDate

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "FileStatus": "Received"
    }
  }'
```

**Expected Result:**
- ✅ `FileStatus` updated to "Received"
- ✅ `FileReceivedDate` auto-stamped with current date
- ✅ `SoftApprovalSentPlanDate` = FileReceivedDate + 2 days (if SoftApprovalReqd = "Yes")
- ✅ `HardApprovalSentPlanDate` = FileReceivedDate + 4 days (if HardApprovalReqd = "Yes")

**Verify:** Query the SQL table to confirm dates were set.

---

### Test Case 2: Update Approval Status → Auto-calculate FinallyApproved

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "SoftApprovalStatus": "Approved",
      "HardApprovalStatus": "Approved",
      "MProofApprovalStatus": "Approved"
    }
  }'
```

**Expected Result:**
- ✅ All three approval statuses updated
- ✅ `FinallyApproved` = "Yes"
- ✅ `FinallyApprovedDate` auto-stamped
- ✅ `ToolingBlanketPlan` = FinallyApprovedDate

---

### Test Case 3: Set "Required" = "No" → Auto-approve

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "SoftApprovalReqd": "No"
    }
  }'
```

**Expected Result:**
- ✅ `SoftApprovalReqd` = "No"
- ✅ `SoftApprovalStatus` = "Approved" (auto-set)
- ✅ `SoftApprovalSentPlanDate` = now
- ✅ `SoftApprovalSentActdate` = now

---

### Test Case 4: Update User Assignment (UserKey → LedgerID mapping)

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "EmployeeUserKey": "biswajit",
      "ToolingUserKey": "rakesh",
      "PlateUserKey": "samir"
    }
  }'
```

**Expected Result:**
- ✅ User keys converted to LedgerIDs via Mongo `user` collection
- ✅ `EmployeeID`, `ToolingPersonID`, `PlatePersonID` updated in SQL
- ✅ If user not found in mapping, sends `NULL` (safe)

**Verify:** Check if user exists in Mongo:
```javascript
// In MongoDB shell or Compass
db.user.findOne({ _id: "biswajit", active: true })
// Should have: erp.KOLKATA.ledgerId: <number>
```

---

### Test Case 5: Update Tooling/Plate Fields

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "ToolingDie": "Ready",
      "ToolingBlock": "Ready",
      "Blanket": "Ready",
      "PlateOutput": "Done",
      "ArtworkRemark": "Test remark",
      "ToolingRemark": "Tooling complete",
      "PlateRemark": "Plate ready"
    }
  }'
```

**Expected Result:**
- ✅ All tooling/plate fields updated
- ✅ If all tooling ready → `ToolingBlanketActual` auto-stamped
- ✅ If `PlateOutput` = "Done" → `PlateActual` auto-stamped (only once)

---

## Step 3: Test MongoDB Updates (MONGO_UNORDERED)

### Test Case 6: Update Mongo Document

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "MONGO_UNORDERED",
    "__MongoId": "65aa1234567890abcdef1234",
    "update": {
      "FileStatus": "Received",
      "SoftApprovalStatus": "Approved",
      "EmployeeUserKey": "biswajit"
    }
  }'
```

**Expected Result:**
- ✅ Document updated in `ArtworkUnordered` collection
- ✅ Business rules applied (dates auto-stamped)
- ✅ Nested structure preserved:
  - `artwork.fileStatus` updated
  - `assignedTo.prepressUserKey` updated
  - `approvals.soft.status` updated

**Verify:** Query MongoDB:
```javascript
db.ArtworkUnordered.findOne({ _id: ObjectId("65aa1234567890abcdef1234") })
```

---

## Step 4: Test Error Cases

### Test Case 7: Missing Required Fields

**Request (Missing __SourceDB):**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "update": {
      "FileStatus": "Received"
    }
  }'
```

**Expected Result:**
- ❌ Error: `"__SourceDB is required in payload"`
- Status: 500

---

### Test Case 8: Missing OrderBookingDetailsID for SQL

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "update": {
      "FileStatus": "Received"
    }
  }'
```

**Expected Result:**
- ❌ Error: `"OrderBookingDetailsID is required for MSSQL update"`
- Status: 500

---

### Test Case 9: Missing __MongoId for Mongo

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "MONGO_UNORDERED",
    "update": {
      "FileStatus": "Received"
    }
  }'
```

**Expected Result:**
- ❌ Error: `"__MongoId is required for MONGO_UNORDERED"`
- Status: 500

---

### Test Case 10: Invalid __SourceDB

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "INVALID_SOURCE",
    "OrderBookingDetailsID": 12345,
    "update": {
      "FileStatus": "Received"
    }
  }'
```

**Expected Result:**
- ❌ Error: `"Unsupported __SourceDB: INVALID_SOURCE"`
- Status: 500

---

## Step 5: Test Business Rules

### Test Case 11: FileStatus = "Pending" → Clear FileReceivedDate

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "FileStatus": "Pending"
    }
  }'
```

**Expected Result:**
- ✅ `FileReceivedDate` set to `null`
- ✅ Plan dates remain unchanged (if already set)

---

### Test Case 12: PlateOutput = "pending" → Set PlatePlan

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "PlateOutput": "pending"
    }
  }'
```

**Expected Result:**
- ✅ If `FinallyApprovedDate` exists → `PlatePlan` = FinallyApprovedDate + 1 day
- ✅ If `FinallyApprovedDate` is null → `PlatePlan` = null

---

### Test Case 13: All Tooling Ready → Auto-stamp ToolingBlanketActual

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "ToolingDie": "Ready",
      "Blanket": "Ready",
      "ToolingBlock": "Not Required"
    }
  }'
```

**Expected Result:**
- ✅ `ToolingBlanketActual` auto-stamped with current date
- ✅ Only if all three conditions met: Die=Ready, Blanket=Ready, Block≠Required

---

## Step 6: Test Normalization

### Test Case 14: Case-Insensitive Input Normalization

**Request:**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "FileStatus": "received",
      "SoftApprovalReqd": "yes",
      "SoftApprovalStatus": "approved"
    }
  }'
```

**Expected Result:**
- ✅ `FileStatus` normalized to "Received"
- ✅ `SoftApprovalReqd` normalized to "Yes"
- ✅ `SoftApprovalStatus` normalized to "Approved"

---

## Step 7: Complete Integration Test

### Test Case 15: Full Workflow (SQL)

**Step 1: Set File Status**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "FileStatus": "Received",
      "SoftApprovalReqd": "Yes",
      "HardApprovalReqd": "Yes",
      "MProofApprovalReqd": "Yes"
    }
  }'
```

**Step 2: Approve All**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "SoftApprovalStatus": "Approved",
      "HardApprovalStatus": "Approved",
      "MProofApprovalStatus": "Approved"
    }
  }'
```

**Step 3: Complete Tooling**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "ToolingDie": "Ready",
      "ToolingBlock": "Ready",
      "Blanket": "Ready"
    }
  }'
```

**Step 4: Complete Plate**
```bash
curl -X POST http://localhost:3001/api/artwork/pending/update \
  -H "Content-Type: application/json" \
  -d '{
    "__SourceDB": "KOL_SQL",
    "__Site": "KOLKATA",
    "OrderBookingDetailsID": 12345,
    "update": {
      "PlateOutput": "Done"
    }
  }'
```

**Expected Final State:**
- ✅ FileStatus = "Received" with FileReceivedDate
- ✅ All approvals = "Approved"
- ✅ FinallyApproved = "Yes" with FinallyApprovedDate
- ✅ ToolingBlanketPlan = FinallyApprovedDate
- ✅ ToolingBlanketActual = now (when all ready)
- ✅ PlatePlan = FinallyApprovedDate + 1 day
- ✅ PlateActual = now

---

## Postman Collection Setup

### Create New Request

1. **Method**: `POST`
2. **URL**: `http://localhost:3001/api/artwork/pending/update`
3. **Headers**:
   ```
   Content-Type: application/json
   ```
4. **Body** (raw JSON):
   ```json
   {
     "__SourceDB": "KOL_SQL",
     "__Site": "KOLKATA",
     "OrderBookingDetailsID": 12345,
     "update": {
       "FileStatus": "Received",
       "SoftApprovalStatus": "Approved"
     }
   }
   ```

### Save as Collection

Create a Postman collection with all test cases above for easy re-running.

---

## Verification Queries

### SQL Verification
```sql
-- Check updated row
SELECT 
  OrderBookingDetailsID,
  FileName, FileReceivedDate,
  SoftApprovalStatus, SoftApprovalSentPlanDate,
  FinallyApproved, FinallyApprovedDate,
  ToolingBlanketPlan, ToolingBlanketActual,
  PlatePlan, PlateActual
FROM dbo.ArtworkProcessApproval
WHERE OrderBookingDetailsID = 12345;
```

### MongoDB Verification
```javascript
// Check updated document
db.ArtworkUnordered.findOne(
  { _id: ObjectId("65aa1234567890abcdef1234") },
  {
    "artwork.fileStatus": 1,
    "artwork.fileReceivedDate": 1,
    "approvals.soft.status": 1,
    "finalApproval.approved": 1,
    "finalApproval.approvedDate": 1,
    "tooling": 1,
    "plate": 1
  }
);
```

---

## Troubleshooting

### Error: "MONGODB_URI_Approval is not configured"
- ✅ Check `.env` file has `MONGODB_URI_Approval=...`
- ✅ Restart backend server after adding env var

### Error: "No database name configured for AHM"
- ✅ Check `.env` file has `DB_NAME_AHM=...`
- ✅ Restart backend server

### Error: "Mongo record not found"
- ✅ Verify `__MongoId` is correct (24-character hex string)
- ✅ Check document exists and `status.isDeleted` ≠ true

### Error: "OrderBookingDetailsID is required"
- ✅ For SQL updates, always include `OrderBookingDetailsID`
- ✅ Must be a valid number > 0

### User mapping not working
- ✅ Verify user exists in Mongo: `db.user.findOne({ _id: "username", active: true })`
- ✅ Check `erp.KOLKATA.ledgerId` or `erp.AHMEDABAD.ledgerId` exists
- ✅ If missing, user will be sent as `NULL` (safe, but shows as "Unknown" in UI)

---

## Success Criteria Checklist

- [ ] SQL updates work for KOL_SQL
- [ ] SQL updates work for AMD_SQL
- [ ] MongoDB updates work for MONGO_UNORDERED
- [ ] FileStatus → FileReceivedDate auto-stamping works
- [ ] Plan dates calculated correctly (FileReceivedDate + 2/4 days)
- [ ] "Required" = "No" → auto-approves correctly
- [ ] FinallyApproved calculated when all 3 approvals = "Approved"
- [ ] ToolingBlanketActual auto-stamps when all tooling ready
- [ ] PlateActual auto-stamps when PlateOutput = "Done" (only once)
- [ ] UserKey → LedgerID mapping works
- [ ] Error handling works (missing fields, invalid IDs)
- [ ] Normalization works (case-insensitive input)
- [ ] Dates are not overridden once set (PlateActual, etc.)

---

## Next Steps

After testing, integrate with frontend:
1. Update `script.js` to call this API when editable fields change
2. Send only modified fields in `update` object
3. Handle response and refresh table data

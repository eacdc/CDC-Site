# Business Logic Documentation
## Artwork Process Approval - Status and Date Calculations

This document describes the business logic implemented in `backend/src/routes-pending-update.js` that calculates statuses and dates before sending data to SQL Server.

---

## Table of Contents

1. [Overview](#overview)
2. [Helper Functions](#helper-functions)
3. [Main Business Logic: `applyRules()`](#main-business-logic-applyrules)
4. [Calculation Rules by Category](#calculation-rules-by-category)
5. [Data Flow](#data-flow)
6. [Examples](#examples)

---

## Overview

The `applyRules()` function is the core business logic engine that:
- Merges incoming update data with existing database state
- Applies automated calculations for statuses and dates
- Ensures data consistency across related fields
- Implements workflow rules for the artwork approval process

**Function Signature:**
```javascript
function applyRules(current, incoming) {
  // current: existing row state (from DB)
  // incoming: update payload (may include only allowed fields)
  // returns: merged object with derived fields updated
}
```

---

## Helper Functions

### 1. `normStr(v)`
Normalizes a value to a string or returns `undefined`/`null` as-is.

**Logic:**
- `undefined` → `undefined`
- `null` → `null`
- Any other value → `String(v)`

---

### 2. `normFileStatus(v)`
Normalizes file status values to standard format: `'Pending'`, `'Received'`, or `'Old'`.

**Allowed Values:**
- `'received'` (case-insensitive) → `'Received'`
- `'old'` (case-insensitive) → `'Old'`
- Any other value → `'Pending'` (default)

**Example:**
```
"RECEIVED" → "Received"
"received" → "Received"
"Pending" → "Pending"
"" → undefined
```

---

### 3. `normApprovalStatus(v)`
Normalizes approval status to one of the valid statuses.

**Valid Statuses:**
- `'Pending'` (default)
- `'Sent'`
- `'Approved'`
- `'Rejected'`
- `'Redo'`

**Logic:**
- Capitalizes first letter, rest lowercase
- If not in valid set → defaults to `'Pending'`

**Example:**
```
"sent" → "Sent"
"SENT" → "Sent"
"approved" → "Approved"
"invalid" → "Pending"
```

---

### 4. `normYesNo(v)`
Converts various boolean-like values to `'Yes'` or `'No'`.

**Truthy Values → `'Yes'`:**
- `'yes'`, `'y'`, `'1'`, `'true'` (case-insensitive)

**Falsy Values → `'No'`:**
- `'no'`, `'n'`, `'0'`, `'false'` (case-insensitive)

**Other values → `undefined`** (no change)

---

### 5. `toDateOrNull(v)`
Converts a value to a Date object or null.

**Logic:**
- `undefined` → `undefined` (means "no change")
- `null` or empty string → `null`
- Valid date string → `Date` object
- Invalid date → `null`

---

### 6. `addDays(d, n)`
Adds `n` days to a Date object.

**Formula:**
```
new Date(d.getTime() + n * 24 * 3600 * 1000)
```

---

## Main Business Logic: `applyRules()`

The `applyRules()` function processes data in **6 sequential sections**. Each section may depend on values calculated in previous sections.

---

## Calculation Rules by Category

### **Section 1: File Status → File Received Date**

**Purpose:** Automatically set or clear `FileReceivedDate` based on `FileStatus`.

**Rules:**

1. **Normalize FileStatus:**
   - Uses `normFileStatus()` to standardize status
   - Falls back to `row.FileName` if `FileStatus` is missing (SQL alias safety)

2. **Set FileReceivedDate:**
   - If `FileStatus === 'Received'` OR `'Old'`:
     - If `FileReceivedDate` is not set → set to current timestamp (`now`)
     - If already set → **preserve existing value**
   
   - If `FileStatus === 'Pending'`:
     - **Always** set `FileReceivedDate = null`

**Code Logic:**
```javascript
if (row.FileStatus === 'Received' || row.FileStatus === 'Old') {
  if (!row.FileReceivedDate) row.FileReceivedDate = now;
} else if (row.FileStatus === 'Pending') {
  row.FileReceivedDate = null;
}
```

**Dependencies:** None (base calculation)

---

### **Section 2: File Received Date → Approval Plan Dates**

**Purpose:** Calculate plan dates for approval submissions based on when the file was received.

**Rules:**

Only applies if `FileReceivedDate` exists and is valid.

For each approval type:

1. **Soft Approval Plan Date:**
   - If `SoftApprovalReqd === 'Yes'` AND `SoftApprovalSentPlanDate` is not set:
     - Set to: `FileReceivedDate + 2 days`

2. **Hard Approval Plan Date:**
   - If `HardApprovalReqd === 'Yes'` AND `HardApprovalSentPlanDate` is not set:
     - Set to: `FileReceivedDate + 4 days`

3. **Machine Proof Approval Plan Date:**
   - If `MProofApprovalReqd === 'Yes'` AND `MProofApprovalSentPlanDate` is not set:
     - Set to: `FileReceivedDate + 4 days`

**Important:** Plan dates are **only set if they don't already exist** (non-destructive).

**Code Logic:**
```javascript
const frd = row.FileReceivedDate ? new Date(row.FileReceivedDate) : null;
if (frd && !isNaN(frd.getTime())) {
  if (row.SoftApprovalReqd === 'Yes' && !row.SoftApprovalSentPlanDate)
    row.SoftApprovalSentPlanDate = addDays(frd, 2);
  if (row.HardApprovalReqd === 'Yes' && !row.HardApprovalSentPlanDate)
    row.HardApprovalSentPlanDate = addDays(frd, 4);
  if (row.MProofApprovalReqd === 'Yes' && !row.MProofApprovalSentPlanDate)
    row.MProofApprovalSentPlanDate = addDays(frd, 4);
}
```

**Dependencies:** Requires Section 1 (`FileReceivedDate`)

---

### **Section 3: Approval Required → Status and Dates**

**Purpose:** Automatically manage approval statuses and dates when approvals are required or not required.

**Rules (applied to each approval type: Soft, Hard, Machine Proof):**

#### **Case A: Approval NOT Required (`*ApprovalReqd === 'No'`)**

When an approval is not required:
1. **Status:** Automatically set to `'Approved'`
2. **Actual Date:** If not set → set to current timestamp (`now`)
3. **Plan Date:** If not set → set to current timestamp (`now`)

**Rationale:** If approval is not required, it's considered immediately approved with current timestamp.

#### **Case B: Approval IS Required (`*ApprovalReqd === 'Yes'`)**

When an approval is required:
1. **Default Status:** If status is not set → default to `'Pending'`
2. **Status = 'Sent':**
   - If status changes to `'Sent'` AND `*ApprovalSentActdate` is not set:
     - Set `*ApprovalSentActdate` to current timestamp (`now`)
3. **Status = 'Redo':**
   - If status is `'Redo'` → clear `*ApprovalSentActdate` (set to `null`)
   - This allows the approval to be re-sent later

**Code Logic (for Soft Approval - same pattern for Hard and Machine Proof):**
```javascript
if (row.SoftApprovalReqd === 'No') {
  row.SoftApprovalStatus = 'Approved';
  if (!row.SoftApprovalSentActdate) row.SoftApprovalSentActdate = now;
  if (!row.SoftApprovalSentPlanDate) row.SoftApprovalSentPlanDate = now;
} else {
  if (!row.SoftApprovalStatus) row.SoftApprovalStatus = 'Pending';
  // If status is Sent => stamp actual
  if (row.SoftApprovalStatus === 'Sent' && !row.SoftApprovalSentActdate)
    row.SoftApprovalSentActdate = now;
  if (row.SoftApprovalStatus === 'Redo') row.SoftApprovalSentActdate = null;
}
```

**Applied To:**
- `SoftApprovalReqd` / `SoftApprovalStatus` / `SoftApprovalSentActdate` / `SoftApprovalSentPlanDate`
- `HardApprovalReqd` / `HardApprovalStatus` / `HardApprovalSentActdate` / `HardApprovalSentPlanDate`
- `MProofApprovalReqd` / `MProofApprovalStatus` / `MProofApprovalSentActdate` / `MProofApprovalSentPlanDate`

**Dependencies:** None (independent calculation per approval type)

---

### **Section 4: Final Approval Calculation**

**Purpose:** Determine if all approvals are complete and set the final approval date.

**Rules:**

1. **Check All Approvals:**
   - Final approval is granted ONLY if ALL three approvals are `'Approved'`:
     - `SoftApprovalStatus === 'Approved'`
     - `HardApprovalStatus === 'Approved'`
     - `MProofApprovalStatus === 'Approved'`

2. **Set FinallyApproved Flag:**
   - If all approved → `FinallyApproved = 'Yes'`
   - Otherwise → `FinallyApproved = 'No'`

3. **Set FinallyApprovedDate:**
   - If all approved AND `FinallyApprovedDate` is not set:
     - Set `FinallyApprovedDate` to current timestamp (`now`)
   - If not all approved → set `FinallyApprovedDate = null`

4. **Set ToolingBlanketPlan:**
   - When `FinallyApprovedDate` is first set:
     - If `ToolingBlanketPlan` is not set → set it to `FinallyApprovedDate`
   - **Rationale:** Tooling blanket plan date is synchronized with final approval date

**Code Logic:**
```javascript
const finalYes =
  row.SoftApprovalStatus === 'Approved' &&
  row.HardApprovalStatus === 'Approved' &&
  row.MProofApprovalStatus === 'Approved';

row.FinallyApproved = finalYes ? 'Yes' : 'No';
if (finalYes) {
  if (!row.FinallyApprovedDate) {
    row.FinallyApprovedDate = now;
    // Rule: ToolingBlanketPlan = FinallyApprovedDate
    if (!row.ToolingBlanketPlan) row.ToolingBlanketPlan = row.FinallyApprovedDate;
  }
} else {
  row.FinallyApprovedDate = null;
}
```

**Dependencies:** Requires Section 3 (all approval statuses)

---

### **Section 5: Plate Dates Calculation**

**Purpose:** Calculate plate plan and actual dates based on plate output status.

**Rules:**

Only applies if `PlateOutput` has a value.

1. **PlateOutput = 'pending' (case-insensitive):**
   - If `PlatePlan` is not set:
     - If `FinallyApprovedDate` exists → set `PlatePlan = FinallyApprovedDate + 1 day`
     - If `FinallyApprovedDate` is null → set `PlatePlan = null`
   - **Important:** If `PlatePlan` already exists → **preserve existing value** (non-destructive)

2. **PlateOutput = 'done' (case-insensitive):**
   - If `PlateActual` is not set → set to current timestamp (`now`)
   - **Important:** If `PlateActual` already exists → **preserve existing value** (prevents overwriting historical data)

**Code Logic:**
```javascript
if (row.PlateOutput) {
  const po = String(row.PlateOutput).trim().toLowerCase();

  if (po === 'pending') {
    if (!row.PlatePlan) {
      if (row.FinallyApprovedDate) {
        const d = new Date(row.FinallyApprovedDate);
        row.PlatePlan = isNaN(d.getTime()) ? null : addDays(d, 1);
      } else {
        row.PlatePlan = null;
      }
    }
  }

  if (po === 'done') {
    if (!row.PlateActual) row.PlateActual = now; // only stamp once
  }
}
```

**Dependencies:** Requires Section 4 (`FinallyApprovedDate`)

---

### **Section 6: Tooling Blanket Actual Date**

**Purpose:** Automatically set `ToolingBlanketActual` when all tooling components are ready.

**Rules:**

Set `ToolingBlanketActual` to current timestamp (`now`) when **ALL** of the following conditions are met:
1. `ToolingDie === 'Ready'`
2. `Blanket === 'Ready'`
3. `ToolingBlock !== 'Required'` (block is either not required, not set, or has another value)

**Important:** Only sets the date if it's not already set (non-destructive).

**Code Logic:**
```javascript
if (row.ToolingDie === 'Ready' && row.Blanket === 'Ready' && row.ToolingBlock !== 'Required') {
  if (!row.ToolingBlanketActual) row.ToolingBlanketActual = now;
}
```

**Dependencies:** None (independent check)

---

## Data Flow

The business logic processes data in the following sequence:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. File Status → FileReceivedDate                           │
│    (Sets/Clears file received date)                         │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. FileReceivedDate → Approval Plan Dates                   │
│    (Calculates plan dates: +2 days for Soft, +4 for Hard/MP)│
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Approval Required → Status & Dates                       │
│    (Auto-approves if not required, manages status if required)│
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. All Approvals → FinallyApproved                          │
│    (Sets final approval when all approvals are 'Approved')  │
│    (Also sets ToolingBlanketPlan = FinallyApprovedDate)     │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. FinallyApprovedDate → Plate Dates                        │
│    (Sets PlatePlan = FinallyApprovedDate + 1 day)           │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. Tooling Components → ToolingBlanketActual                │
│    (Sets actual date when all components are ready)         │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Principles

1. **Non-Destructive Updates:**
   - Most date fields are only set if they don't already exist
   - Prevents overwriting manually entered or historical data
   - Exception: `FileReceivedDate` is cleared when status is 'Pending'

2. **Cascading Calculations:**
   - Later sections depend on earlier calculations
   - Changes in one section may trigger updates in dependent sections

3. **Status Normalization:**
   - All status values are normalized to standard formats
   - Invalid values default to safe defaults (usually 'Pending')

4. **Current Timestamp Usage:**
   - `now = new Date()` is created once at the start of `applyRules()`
   - Used consistently for all "current time" stamps
   - Ensures all timestamps in a single update are synchronized

---

## Examples

### Example 1: File Status Change from 'Pending' to 'Received'

**Input:**
```javascript
current = {
  FileStatus: 'Pending',
  FileReceivedDate: null,
  SoftApprovalReqd: 'Yes',
  HardApprovalReqd: 'Yes'
}

incoming = {
  FileStatus: 'Received'
}
```

**After applyRules():**
```javascript
{
  FileStatus: 'Received',
  FileReceivedDate: <current timestamp>,        // ✅ Set automatically
  SoftApprovalSentPlanDate: <FileReceivedDate + 2 days>,  // ✅ Calculated
  HardApprovalSentPlanDate: <FileReceivedDate + 4 days>,  // ✅ Calculated
  SoftApprovalReqd: 'Yes',
  HardApprovalReqd: 'Yes',
  SoftApprovalStatus: 'Pending',                // ✅ Default
  HardApprovalStatus: 'Pending'                 // ✅ Default
}
```

---

### Example 2: Approval Not Required

**Input:**
```javascript
current = {
  HardApprovalReqd: 'Yes',
  HardApprovalStatus: 'Pending'
}

incoming = {
  HardApprovalReqd: 'No'
}
```

**After applyRules():**
```javascript
{
  HardApprovalReqd: 'No',
  HardApprovalStatus: 'Approved',               // ✅ Auto-approved
  HardApprovalSentActdate: <current timestamp>, // ✅ Stamped
  HardApprovalSentPlanDate: <current timestamp> // ✅ Stamped
}
```

---

### Example 3: All Approvals Complete → Final Approval

**Input:**
```javascript
current = {
  SoftApprovalStatus: 'Approved',
  HardApprovalStatus: 'Approved',
  MProofApprovalStatus: 'Pending',
  FinallyApproved: 'No',
  FinallyApprovedDate: null,
  ToolingBlanketPlan: null
}

incoming = {
  MProofApprovalStatus: 'Approved'
}
```

**After applyRules():**
```javascript
{
  SoftApprovalStatus: 'Approved',
  HardApprovalStatus: 'Approved',
  MProofApprovalStatus: 'Approved',
  FinallyApproved: 'Yes',                       // ✅ All approved
  FinallyApprovedDate: <current timestamp>,     // ✅ Set
  ToolingBlanketPlan: <same as FinallyApprovedDate> // ✅ Synchronized
}
```

---

### Example 4: Plate Output Status Change

**Input:**
```javascript
current = {
  FinallyApprovedDate: '2024-01-15T10:00:00Z',
  PlateOutput: 'pending',
  PlatePlan: null
}

incoming = {
  PlateOutput: 'pending'  // No change, but rule still applies
}
```

**After applyRules():**
```javascript
{
  FinallyApprovedDate: '2024-01-15T10:00:00Z',
  PlateOutput: 'pending',
  PlatePlan: '2024-01-16T10:00:00Z'  // ✅ FinallyApprovedDate + 1 day
}
```

**Later, when plate is done:**
```javascript
incoming = {
  PlateOutput: 'done'
}
```

**After applyRules():**
```javascript
{
  PlateOutput: 'done',
  PlatePlan: '2024-01-16T10:00:00Z',  // ✅ Preserved
  PlateActual: <current timestamp>     // ✅ Stamped
}
```

---

### Example 5: Tooling Components Ready

**Input:**
```javascript
current = {
  ToolingDie: 'Ready',
  Blanket: 'Ready',
  ToolingBlock: 'Not Required',
  ToolingBlanketActual: null
}
```

**After applyRules():**
```javascript
{
  ToolingDie: 'Ready',
  Blanket: 'Ready',
  ToolingBlock: 'Not Required',
  ToolingBlanketActual: <current timestamp>  // ✅ All ready, date set
}
```

---

## Summary

The `applyRules()` function implements a comprehensive workflow automation system that:

- **Automates date calculations** based on business rules (e.g., plan dates are calculated from file received date)
- **Manages approval statuses** automatically (e.g., auto-approve if not required)
- **Enforces dependencies** between fields (e.g., final approval depends on all individual approvals)
- **Preserves existing data** when possible (non-destructive updates)
- **Ensures data consistency** across related fields (e.g., final approval date and tooling blanket plan date)

This logic runs **before** data is sent to the SQL Server stored procedure, ensuring that all calculated fields are ready for persistence.

---

**Last Updated:** 2024
**File:** `backend/src/routes-pending-update.js`
**Function:** `applyRules(current, incoming)`

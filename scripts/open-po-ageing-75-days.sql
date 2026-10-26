/* =====================================================================
   Open PO lines older than 75 days
   Plant   : Kolkata  -> IndusEnterprise      (Ahmedabad -> IndusEnterprise2)
   Company : 2
   Read-only. Two result sets: (1) line detail, (2) one row per PO.

   Why it is built this way
   -----------------------
   * Pending qty is COMPUTED from receipts, never read from a status column.
     Closure is per LINE (ITD.IsCompleted); PO-level status is an aggregate.
   * Receipts link to the PO HEADER: ITD.PurchaseTransactionID -> PO
     TransactionID. PO-line matching is therefore PurchaseTransactionID + ItemID.
   * Both sides are compared in the PURCHASE unit:
       PO side  = ITD.PurchaseOrderQuantity
       GRN side = ITD.ChallanWeight        (ITD.ReceiptQuantity is stock unit)
     This is the pattern in backend/src/supplier-portal/services/erp-po.js
     (openPoLines), verified end to end on KV/26-27/12945.
   * Pattern copied rather than invented. Do not "simplify" the filters:
     IsCancelled and IsDeletedTransaction are different flags, and
     ItemTransactionMain has no IsCancelled column at all.
   ===================================================================== */

USE IndusEnterprise;      -- Kolkata. Run the identical script on IndusEnterprise2 for Ahmedabad.
GO

SET NOCOUNT ON;

DECLARE @CompanyID        INT   = 2,
        @AgeDays          INT   = 75,      -- PO older than this many days
        @AsOn             DATE  = CAST(GETDATE() AS DATE),
        @ClosureTolerance FLOAT = 0.10,    -- TOLERANCES.closurePendingPct: <=10% pending is closeable
        @IncludeCompleted BIT   = 0;       -- 1 = also show lines already closed

DECLARE @PO INT = -11, @GRN INT = -14, @ALLOC INT = -17;

IF OBJECT_ID('tempdb..#PoLine')   IS NOT NULL DROP TABLE #PoLine;
IF OBJECT_ID('tempdb..#Received') IS NOT NULL DROP TABLE #Received;
IF OBJECT_ID('tempdb..#Alloc')    IS NOT NULL DROP TABLE #Alloc;

/* ---------- 1. PO lines older than @AgeDays ------------------------- */
SELECT  ITD.TransactionDetailID,
        ITD.TransactionID                   AS PoTransactionID,
        ITM.VoucherNo                       AS PoNo,
        CAST(ITM.VoucherDate AS DATE)       AS PoDate,
        ITM.FYear,
        ITM.LedgerID,
        ITD.ItemID,
        ITD.ItemGroupID,
        ITD.PurchaseUnit,
        ITD.StockUnit,
        ISNULL(ITD.PurchaseOrderQuantity,0) AS PoQty,
        ITD.ChallanWeight                   AS PoQtyStockUnit,
        ITD.PurchaseRate,
        ITD.PurchaseTolerance,
        ITD.ExpectedDeliveryDate,
        ITD.WarehouseID,
        ITD.ItemDescription,
        ISNULL(ITD.IsCompleted,0)           AS IsCompleted,
        ITD.CompletedDate,
        ISNULL(ITD.CompletedBy,0)           AS CompletedBy
INTO    #PoLine
FROM    dbo.ItemTransactionDetail ITD
JOIN    dbo.ItemTransactionMain   ITM
        ON  ITM.TransactionID = ITD.TransactionID
        AND ITM.CompanyID     = ITD.CompanyID
WHERE   ITD.CompanyID = @CompanyID
  AND   ITM.VoucherID = @PO
  AND   ITM.VoucherDate < DATEADD(DAY, -@AgeDays, @AsOn)
  AND   (@IncludeCompleted = 1 OR ISNULL(ITD.IsCompleted,0) = 0)
  AND   ISNULL(ITD.IsDeletedTransaction,0) = 0
  AND   ISNULL(ITD.IsCancelled,0)          = 0
  AND   ISNULL(ITM.IsDeletedTransaction,0) = 0;

CREATE CLUSTERED INDEX IX_PoLine ON #PoLine (PoTransactionID, ItemID);

/* ---------- 2. Receipts against those POs --------------------------- */
/* Grouped by ItemID as well as PO, because that is how the ERP links a
   receipt to a PO line. Receipts booked under a substituted ItemID are
   still surfaced below as ReceivedOnPoAnyItem, so a line that is open only
   because of substitution is visible rather than silently stuck open.    */
SELECT  ITD.PurchaseTransactionID            AS PoTransactionID,
        ITD.ItemID,
        SUM(ISNULL(ITD.ChallanWeight,0))     AS ReceivedQty,          -- purchase unit
        SUM(ISNULL(ITD.ReceiptQuantity,0))   AS ReceivedStockQty,     -- stock unit
        SUM(ISNULL(ITD.RejectedQuantity,0))  AS RejectedQty,
        MAX(CAST(ITM.VoucherDate AS DATE))   AS LastReceiptDate,
        COUNT(DISTINCT ITD.TransactionID)    AS GrnCount
INTO    #Received
FROM    dbo.ItemTransactionDetail ITD
JOIN    dbo.ItemTransactionMain   ITM
        ON  ITM.TransactionID = ITD.TransactionID
        AND ITM.CompanyID     = ITD.CompanyID
WHERE   ITD.CompanyID = @CompanyID
  AND   ITM.VoucherID = @GRN
  AND   ITD.PurchaseTransactionID > 0
  AND   EXISTS (SELECT 1 FROM #PoLine P WHERE P.PoTransactionID = ITD.PurchaseTransactionID)
  AND   ISNULL(ITD.IsDeletedTransaction,0) = 0
  AND   ISNULL(ITD.IsCancelled,0)          = 0
  AND   ISNULL(ITM.IsDeletedTransaction,0) = 0
GROUP BY ITD.PurchaseTransactionID, ITD.ItemID;

CREATE CLUSTERED INDEX IX_Received ON #Received (PoTransactionID, ItemID);

/* ---------- 3. Allocations still pointing at those POs -------------- */
/* A line carrying job allocations must not be closed blindly: jobs are
   still waiting on that material. usp_ClosePendingPOs does the
   authoritative open-allocation test; this is only the report flag.      */
SELECT  ITD.PurchaseTransactionID                         AS PoTransactionID,
        ITD.ItemID,
        SUM(ISNULL(ITD.RequiredQuantity,0))               AS AllocatedQty,
        COUNT(DISTINCT ITD.JobBookingJobCardContentsID)   AS JobComponents
INTO    #Alloc
FROM    dbo.ItemTransactionDetail ITD
JOIN    dbo.ItemTransactionMain   ITM
        ON  ITM.TransactionID = ITD.TransactionID
        AND ITM.CompanyID     = ITD.CompanyID
WHERE   ITD.CompanyID = @CompanyID
  AND   ITM.VoucherID = @ALLOC
  AND   ITD.PurchaseTransactionID > 0
  AND   EXISTS (SELECT 1 FROM #PoLine P WHERE P.PoTransactionID = ITD.PurchaseTransactionID)
  AND   ISNULL(ITD.IsDeletedTransaction,0) = 0
  AND   ISNULL(ITD.IsCancelled,0)          = 0
  AND   ISNULL(ITM.IsDeletedTransaction,0) = 0
GROUP BY ITD.PurchaseTransactionID, ITD.ItemID;

CREATE CLUSTERED INDEX IX_Alloc ON #Alloc (PoTransactionID, ItemID);

/* ===================== RESULT 1 - line detail ====================== */
SELECT
    P.PoNo,
    P.PoDate,
    DATEDIFF(DAY, P.PoDate, @AsOn)                          AS DaysOld,
    LM.LedgerName                                           AS SupplierName,
    IM.ItemCode,
    IM.ItemName,
    IM.Quality,
    IM.GSM,
    IM.SizeW,
    IM.SizeL,
    P.PurchaseUnit,
    P.PoQty,
    ISNULL(R.ReceivedQty,0)                                 AS ReceivedQty,
    P.PoQty - ISNULL(R.ReceivedQty,0)                       AS PendingQty,
    CAST(100.0 * ISNULL(R.ReceivedQty,0)
         / NULLIF(P.PoQty,0) AS DECIMAL(9,2))               AS PctReceived,
    P.PurchaseRate,
    CAST((P.PoQty - ISNULL(R.ReceivedQty,0))
         * ISNULL(P.PurchaseRate,0) AS DECIMAL(18,2))       AS PendingValue,   -- basic rate, no GST
    P.ExpectedDeliveryDate,
    CASE WHEN P.ExpectedDeliveryDate IS NOT NULL
         THEN DATEDIFF(DAY, P.ExpectedDeliveryDate, @AsOn) END AS DaysPastExpected,
    R.LastReceiptDate,
    DATEDIFF(DAY, R.LastReceiptDate, @AsOn)                 AS DaysSinceLastReceipt,
    ISNULL(R.GrnCount,0)                                    AS GrnCount,
    ISNULL(R.RejectedQty,0)                                 AS RejectedQty,
    /* All receipts on this PO regardless of ItemID. Well above ReceivedQty
       means the line is open only because of item substitution.           */
    ISNULL(RA.ReceivedAnyItemQty,0)                         AS ReceivedOnPoAnyItem,
    ISNULL(A.AllocatedQty,0)                                AS AllocQtyOnLine,
    ISNULL(A.JobComponents,0)                               AS JobComponentsWaiting,
    /* Bucket names follow usp_ClosePendingPOs. Confirm its exact thresholds
       there before using this report to drive an actual closure run.      */
    CASE
        WHEN ISNULL(R.ReceivedQty,0) = 0
            THEN 'DEAD_NO_RECEIPT'
        WHEN P.PoQty - ISNULL(R.ReceivedQty,0) <= P.PoQty * @ClosureTolerance
            THEN 'TOLERANCE'
        WHEN R.LastReceiptDate >= DATEADD(DAY, -@AgeDays, @AsOn)
            THEN 'PARTIAL_LIVE'
        ELSE 'PARTIAL_STALE'
    END                                                     AS AgeingBucket,
    P.IsCompleted,
    P.CompletedDate,
    UM.UserName                                             AS ClosedBy,
    P.PoTransactionID,
    P.TransactionDetailID,
    P.ItemID,
    P.ItemGroupID,
    P.FYear
FROM        #PoLine P
LEFT JOIN   #Received R
            ON  R.PoTransactionID = P.PoTransactionID
            AND R.ItemID          = P.ItemID
LEFT JOIN  (SELECT PoTransactionID, SUM(ReceivedQty) AS ReceivedAnyItemQty
            FROM   #Received
            GROUP BY PoTransactionID) RA
            ON  RA.PoTransactionID = P.PoTransactionID
LEFT JOIN   #Alloc A
            ON  A.PoTransactionID = P.PoTransactionID
            AND A.ItemID          = P.ItemID
LEFT JOIN   dbo.LedgerMaster LM
            ON  LM.LedgerID  = P.LedgerID
            AND LM.CompanyID = @CompanyID
LEFT JOIN   dbo.ItemMaster IM
            ON  IM.ItemID    = P.ItemID
            AND IM.CompanyID = @CompanyID
LEFT JOIN   dbo.UserMaster UM
            ON  UM.UserID = P.CompletedBy
            AND P.CompletedBy > 0
WHERE       P.PoQty - ISNULL(R.ReceivedQty,0) > 0.001
ORDER BY    DaysOld DESC, P.PoNo, P.TransactionDetailID;

/* ===================== RESULT 2 - one row per PO =================== */
WITH Line AS (
    SELECT  P.PoTransactionID, P.PoNo, P.PoDate, P.LedgerID,
            P.PoQty,
            ISNULL(R.ReceivedQty,0)             AS ReceivedQty,
            P.PoQty - ISNULL(R.ReceivedQty,0)   AS PendingQty,
            (P.PoQty - ISNULL(R.ReceivedQty,0)) * ISNULL(P.PurchaseRate,0) AS PendingValue,
            R.LastReceiptDate,
            ISNULL(A.AllocatedQty,0)            AS AllocatedQty
    FROM        #PoLine P
    LEFT JOIN   #Received R
                ON R.PoTransactionID = P.PoTransactionID AND R.ItemID = P.ItemID
    LEFT JOIN   #Alloc A
                ON A.PoTransactionID = P.PoTransactionID AND A.ItemID = P.ItemID
    WHERE       P.PoQty - ISNULL(R.ReceivedQty,0) > 0.001
)
SELECT
    L.PoNo,
    L.PoDate,
    DATEDIFF(DAY, L.PoDate, @AsOn)                      AS DaysOld,
    LM.LedgerName                                       AS SupplierName,
    COUNT(*)                                            AS OpenLines,
    CAST(SUM(L.PendingQty)   AS DECIMAL(18,3))          AS TotalPendingQty,
    CAST(SUM(L.PendingValue) AS DECIMAL(18,2))          AS TotalPendingValue,
    CAST(100.0 * SUM(L.ReceivedQty)
         / NULLIF(SUM(L.PoQty),0) AS DECIMAL(9,2))      AS PctReceived,
    MAX(L.LastReceiptDate)                              AS LastReceiptDate,
    CASE WHEN SUM(L.AllocatedQty) > 0 THEN 'YES' ELSE 'NO' END AS HasJobAllocations,
    L.PoTransactionID
FROM        Line L
LEFT JOIN   dbo.LedgerMaster LM
            ON  LM.LedgerID  = L.LedgerID
            AND LM.CompanyID = @CompanyID
GROUP BY    L.PoTransactionID, L.PoNo, L.PoDate, L.LedgerID, LM.LedgerName
ORDER BY    DaysOld DESC, TotalPendingValue DESC;

DROP TABLE #PoLine, #Received, #Alloc;

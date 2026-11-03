/*
 * Removes the two test barcodes made on 3 Nov 2026 while testing mixed boxes.
 * KOLKATA ONLY (IndusEnterprise). Run once in SSMS.
 *
 *   1302174  mixed box: J08430_26_27 (JobBookingID 17576) qty 1 + J08431_26_27 (17577) qty 2
 *   1302175  one PWO:   J08430_26_27 (17576) qty 1
 *
 * Their GPNs (FG13001, FG13002) and delivery notes (DN5745, DN5746) were already
 * deleted through the app. Those stay as deleted history in
 * FinishGoodsTransaction*: every scan, report and status lookup ignores them.
 *
 * The delete only runs if no LIVE GPN or delivery-note line uses either barcode,
 * and only touches the exact test rows (barcode + job + qty).
 */
USE IndusEnterprise;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF EXISTS (
    SELECT 1 FROM dbo.FinishGoodsTransactionDetail d
    JOIN dbo.FinishGoodsTransactionMain m ON m.FGTransactionID = d.FGTransactionID
    WHERE d.Barcode IN (N'1302174', N'1302175')
      AND ISNULL(d.IsDeletedTransaction, 0) = 0
      AND ISNULL(m.IsDeletedTransaction, 0) = 0
)
BEGIN
    RAISERROR('A live GPN or delivery note uses a test barcode. Nothing was deleted.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
END

DELETE FROM dbo.PackingSlipBarcodeEntry
WHERE (BarcodeNo = 1302174 AND JobBookingID = 17576 AND QuantityPerBox = 1)
   OR (BarcodeNo = 1302174 AND JobBookingID = 17577 AND QuantityPerBox = 2)
   OR (BarcodeNo = 1302175 AND JobBookingID = 17576 AND QuantityPerBox = 1);

IF @@ROWCOUNT <> 3
BEGIN
    RAISERROR('Expected to delete exactly 3 rows. Nothing was deleted.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
END

COMMIT TRANSACTION;

/* Check: should return no rows. */
SELECT * FROM dbo.PackingSlipBarcodeEntry WHERE BarcodeNo IN (1302174, 1302175);

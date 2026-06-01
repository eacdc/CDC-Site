/*
 * Adds GateInActualDate and OriginDepartureActualDate columns to dbo.ShipmentETA.
 *
 * Run this script ONCE on EACH database (KOL and AHM) before redeploying the
 * backend that expects these columns (see backend/src/routes-shipment-eta.js).
 *
 * Idempotent: each ALTER is guarded by a column-existence check, so re-running
 * is safe.
 *
 * Stored types intentionally match the existing date-as-text columns
 * (DestinationArrivalOriginalPlannedDate / DestinationArrivalPlannedDate) so
 * we do not have to translate Excel cell formats.
 */

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE [object_id] = OBJECT_ID(N'dbo.ShipmentETA')
      AND name = N'GateInActualDate'
)
BEGIN
    ALTER TABLE dbo.ShipmentETA
        ADD GateInActualDate NVARCHAR(64) NULL;
END;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE [object_id] = OBJECT_ID(N'dbo.ShipmentETA')
      AND name = N'OriginDepartureActualDate'
)
BEGIN
    ALTER TABLE dbo.ShipmentETA
        ADD OriginDepartureActualDate NVARCHAR(64) NULL;
END;
GO

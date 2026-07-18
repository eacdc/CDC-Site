-- Add DestinationArrivalActualDate to ShipmentETA (run on KOL and AHM databases).
IF COL_LENGTH('dbo.ShipmentETA', 'DestinationArrivalActualDate') IS NULL
BEGIN
  ALTER TABLE dbo.ShipmentETA
    ADD DestinationArrivalActualDate NVARCHAR(255) NULL;
END;

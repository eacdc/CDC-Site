/*
 * One-time cleanup: remove duplicate ContainerNumber rows from dbo.ShipmentETA.
 *
 * - Keeps the LATEST saved row per ContainerNumber (highest Id, with CreatedAt
 *   as a tiebreaker for safety).
 * - Leaves rows with NULL/empty ContainerNumber untouched.
 * - Wrapped in an explicit transaction so you can review the preview output and
 *   the deletion count before committing.
 * - The final (commented) step adds a UNIQUE filtered index so the database
 *   itself prevents future duplicate ContainerNumbers. Enable it after the
 *   backend upload route is deployed with the upsert-on-conflict behavior.
 *
 * Run this script ONCE on EACH database (KOL and AHM). Set the database
 * context (USE [your_db_name]) before executing.
 */

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRANSACTION;

-- 1) Preview: rows that WILL be deleted (everything except the latest per
--    ContainerNumber). Review this before committing.
;WITH ranked AS (
    SELECT  Id,
            ContainerNumber,
            CreatedAt,
            ROW_NUMBER() OVER (
                PARTITION BY ContainerNumber
                ORDER BY Id DESC, CreatedAt DESC
            ) AS rn
    FROM    dbo.ShipmentETA
    WHERE   ContainerNumber IS NOT NULL
      AND   LEN(ContainerNumber) > 0
)
SELECT  Id,
        ContainerNumber,
        CreatedAt,
        rn AS DuplicateRank   -- rn = 1 is the row we keep; rn > 1 will be deleted
FROM    ranked
WHERE   rn > 1
ORDER BY ContainerNumber, rn;

-- 2) Delete the older duplicates (everything except rn = 1 per ContainerNumber).
;WITH ranked AS (
    SELECT  Id,
            ROW_NUMBER() OVER (
                PARTITION BY ContainerNumber
                ORDER BY Id DESC, CreatedAt DESC
            ) AS rn
    FROM    dbo.ShipmentETA
    WHERE   ContainerNumber IS NOT NULL
      AND   LEN(ContainerNumber) > 0
)
DELETE FROM ranked WHERE rn > 1;

PRINT CONCAT('Duplicate rows deleted: ', @@ROWCOUNT);

-- 3) Sanity check: every non-null ContainerNumber should now appear exactly once.
SELECT  ContainerNumber,
        COUNT(*) AS RowCountStill
FROM    dbo.ShipmentETA
WHERE   ContainerNumber IS NOT NULL
  AND   LEN(ContainerNumber) > 0
GROUP BY ContainerNumber
HAVING COUNT(*) > 1;
-- ^ This SELECT should return zero rows. If it does, do NOT commit and
--   investigate (the dedup logic above assumes (Id, CreatedAt) uniquely orders rows).

-- 4) Decide what to do with the transaction:
--      COMMIT TRANSACTION;       -- keep the cleanup
--      ROLLBACK TRANSACTION;     -- abort and leave data untouched
-- Uncomment ONE of the two lines below after reviewing the preview output:

-- COMMIT TRANSACTION;
-- ROLLBACK TRANSACTION;

GO

/* -----------------------------------------------------------------------------
 * 5) (Optional but recommended) Defense-in-depth: prevent future duplicates at
 *    the database level. Run this AFTER step 4 commits successfully and AFTER
 *    the new backend (with upsert-on-conflict) is deployed.
 *
 *    Filtered index allows multiple NULL ContainerNumber rows but enforces
 *    uniqueness on every actual container number.
 * -----------------------------------------------------------------------------
 */

-- IF NOT EXISTS (
--     SELECT 1 FROM sys.indexes
--     WHERE name = N'UX_ShipmentETA_ContainerNumber'
--       AND object_id = OBJECT_ID(N'dbo.ShipmentETA')
-- )
-- BEGIN
--     CREATE UNIQUE INDEX UX_ShipmentETA_ContainerNumber
--         ON dbo.ShipmentETA (ContainerNumber)
--         WHERE ContainerNumber IS NOT NULL;
-- END;
-- GO

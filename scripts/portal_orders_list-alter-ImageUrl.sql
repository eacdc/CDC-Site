/*
  IndusEnterprise — dbo.portal_orders_list
  Fix ImageUrl when JobCardProductImg / ProductImgStringName store full http(s) URLs
  (e.g. Cloudinary). Run on each catalog that serves the customer portal (KOL/AHM if applicable).
*/

USE [IndusEnterprise];
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

ALTER PROCEDURE [dbo].[portal_orders_list]
  @LedgerIds        dbo.IdList READONLY,
  @FromDate         DATE       = NULL,
  @ToDate           DATE       = NULL,
  @Status           VARCHAR(12)= 'all',
  @Search           NVARCHAR(100) = N'',
  @AfterDate        DATETIME2(0) = NULL,
  @AfterJobId       INT          = NULL,
  @Limit            INT          = 500
AS
BEGIN
  SET NOCOUNT ON;

  DECLARE @ImageBaseUrl NVARCHAR(200) =
    N'https://cdcindas.24mycloud.com/Files/ProductImages/';

  ;WITH FinishPlanJob AS (
      SELECT JEJC.JobBookingID,
          DATEADD(DAY, 1, MAX(JSS.PlannedEndTime)) AS FinishPlanDate
      FROM dbo.JobBookingJobCardContents JEJC
      JOIN dbo.JobScheduleRelease JSS
        ON JSS.JobBookingJobCardContentsID = JEJC.JobBookingJobCardContentsID
       AND ISNULL(JSS.IsDeletedTransaction,0)=0
      GROUP BY JEJC.JobBookingID
  ),

  OrderFlags AS (
    SELECT JEJ.JobBookingID,
           JEJ.IsClose,
           JEJ.IsCancel
    FROM dbo.JobBookingJobCard JEJ
  ),

  GPNAgg AS (
    SELECT
      fgd.JobBookingID,
      SUM(ISNULL(fgd.outercarton,0) * ISNULL(fgd.innercarton,0) * ISNULL(fgd.quantityperpack,0)) AS GpnUnits,
      MAX(COALESCE(TRY_CONVERT(datetime, fgm.VoucherDate), TRY_CONVERT(datetime, fgm.CreatedDate))) AS LastGpnDate
    FROM dbo.FinishGoodsTransactionMain fgm
    JOIN dbo.FinishGoodsTransactiondetail fgd
      ON fgd.FGTransactionID = fgm.FGtransactionID
    WHERE fgm.voucherid = -50
      AND ISNULL(fgm.IsDeletedTransaction,0)=0
      AND ISNULL(fgd.IsDeletedTransaction,0)=0
    GROUP BY fgd.JobBookingID
  ),

  DispatchAgg AS (
    SELECT
      fgd.JobBookingID,
      SUM(ISNULL(fgd.innercarton,0) * ISNULL(fgd.quantityperpack,0)) AS DispatchedUnits,
      MAX(COALESCE(TRY_CONVERT(datetime, fgm.VoucherDate), TRY_CONVERT(datetime, fgm.CreatedDate))) AS LastDispatchDate
    FROM dbo.FinishGoodsTransactionMain fgm
    JOIN dbo.FinishGoodsTransactiondetail fgd
      ON fgd.FGTransactionID = fgm.FGtransactionID
    WHERE fgm.voucherid = -51
      AND ISNULL(fgm.IsDeletedTransaction,0)=0
      AND ISNULL(fgd.IsDeletedTransaction,0)=0
    GROUP BY fgd.JobBookingID
  ),

  ApprovalAgg AS (
    SELECT
      APA.OrderBookingDetailsID,
      MAX(TRY_CONVERT(date, APA.FinallyApprovedDate)) AS ApprovalDate,
      MAX(CASE
            WHEN TRY_CONVERT(int, APA.FinallyApproved) = 1 THEN 1
            WHEN UPPER(LTRIM(RTRIM(CAST(APA.FinallyApproved AS NVARCHAR(10))))) IN ('Y','YES','TRUE') THEN 1
            ELSE 0
          END) AS IsApproved
    FROM dbo.ArtworkProcessApproval APA WITH (NOLOCK)
    GROUP BY APA.OrderBookingDetailsID
  ),

  Base AS (
    SELECT
      JEJ.JobBookingID,
      JEJ.JobBookingNo,
      JEJ.JobBookingDate,
      JOB.PONo,
      JOBD.PODate,
      JEJ.JobName     AS Title,
      TRY_CONVERT(date, JOBD.ExpectedDeliveryDate) AS CommittedDeliveryDate,

      JEJ.Jobcardproductimg AS JobCardProductImg,
      PM.ImgStringName      AS ProductImgStringName,

      JEJ.OrderQuantity     AS OrderQty,

      GA.GpnUnits           AS PackedQty,
      DA.DispatchedUnits    AS DeliveredQty,

      FPJ.FinishPlanDate,

      CASE 
        WHEN OFL.IsCancel = 1 THEN 'Cancelled'
        WHEN OFL.IsClose = 1 THEN 'Closed'
        WHEN ISNULL(DA.DispatchedUnits,0) >= 0.9 * ISNULL(JEJ.OrderQuantity,0) THEN 'Completed'
        ELSE 'Open'
      END AS FinalStatus,

      GA.LastGpnDate,
      DA.LastDispatchDate,
      AA.ApprovalDate,
      AA.IsApproved
    FROM dbo.JobBookingJobCard JEJ
    JOIN dbo.JobOrderBookingDetails JOBD
      ON JOBD.OrderBookingID = JEJ.OrderBookingID
     AND JOBD.OrderBookingDetailsID = JEJ.OrderBookingDetailsID
    JOIN dbo.JobOrderBooking JOB
      ON JOB.OrderBookingID = JOBD.OrderBookingID
    LEFT JOIN dbo.ProductMaster PM
      ON PM.ProductMasterCode = JOBD.ProductMasterCode

    LEFT JOIN FinishPlanJob FPJ ON FPJ.JobBookingID = JEJ.JobBookingID
    LEFT JOIN OrderFlags OFL    ON OFL.JobBookingID = JEJ.JobBookingID
    LEFT JOIN GPNAgg GA         ON GA.JobBookingID = JEJ.JobBookingID
    LEFT JOIN DispatchAgg DA    ON DA.JobBookingID = JEJ.JobBookingID
    LEFT JOIN ApprovalAgg AA    ON AA.OrderBookingDetailsID = JOBD.OrderBookingDetailsID

    WHERE
      JEJ.IsCancel = 0
      AND ISNULL(JEJ.IsDeletedTransaction,0) = 0
      AND ISNULL(JOB.IsDeletedTransaction,0) = 0
      AND ISNULL(JOBD.IsDeletedTransaction,0) = 0
      AND JOB.LedgerID IN (SELECT Id FROM @LedgerIds)
      AND (@FromDate IS NULL OR JEJ.JobBookingDate >= @FromDate)
      AND (@ToDate   IS NULL OR JEJ.JobBookingDate < DATEADD(DAY,1,@ToDate))
      AND (
        @Search = N'' OR
        JOB.PONo LIKE N'%'+@Search+N'%' OR
        JEJ.JobBookingNo LIKE N'%'+@Search+N'%' OR
        JEJ.JobName LIKE N'%'+@Search+N'%'
      )
  ),

  Filtered AS (
    SELECT * FROM Base
    WHERE (@Status = 'all')
       OR (@Status = 'pending'   AND FinalStatus IN ('Open','Pending','Incomplete','Not Planned'))
       OR (@Status = 'completed' AND FinalStatus IN ('Completed','Closed'))
  )

  SELECT TOP (@Limit)
      /* ImageUrl: absolute URL (Cloudinary etc.) unchanged; bare filename still gets @ImageBaseUrl */
      CASE
        WHEN ISNULL(LTRIM(RTRIM(JobCardProductImg)), N'') <> N''
          AND (
               LOWER(LEFT(LTRIM(RTRIM(JobCardProductImg)), 8)) = N'https://'
            OR LOWER(LEFT(LTRIM(RTRIM(JobCardProductImg)), 7)) = N'http://'
          )
          THEN LTRIM(RTRIM(JobCardProductImg))
        WHEN ISNULL(LTRIM(RTRIM(JobCardProductImg)), N'') <> N''
          THEN @ImageBaseUrl + JobCardProductImg
        WHEN ISNULL(LTRIM(RTRIM(ProductImgStringName)), N'') <> N''
          AND (
               LOWER(LEFT(LTRIM(RTRIM(ProductImgStringName)), 8)) = N'https://'
            OR LOWER(LEFT(LTRIM(RTRIM(ProductImgStringName)), 7)) = N'http://'
          )
          THEN LTRIM(RTRIM(ProductImgStringName))
        WHEN ISNULL(LTRIM(RTRIM(ProductImgStringName)), N'') <> N''
          THEN @ImageBaseUrl + ProductImgStringName
        ELSE NULL
      END AS ImageUrl,

      Title,
      PONo AS PoNumber,
      TRY_CONVERT(date, PODate) AS PoDate,
      CASE WHEN IsApproved = 1 THEN ApprovalDate ELSE NULL END AS ApprovalDate,
      JobBookingNo AS JobCardNo,
      CommittedDeliveryDate,
      OrderQty,
      PackedQty AS QtyPacked,
      DeliveredQty AS QtyDelivered,
      FinalStatus AS FinalOrderStatus,

      FinishPlanDate,

      JobBookingID AS JobBookingId,
      JobBookingDate AS _cursorDate,
      JobBookingID AS _cursorId

  FROM Filtered f
  WHERE
     (@AfterDate IS NULL AND @AfterJobId IS NULL)
     OR (f.JobBookingDate < @AfterDate)
     OR (f.JobBookingDate = @AfterDate AND f.JobBookingID < @AfterJobId)
  ORDER BY f.JobBookingDate DESC, f.JobBookingID DESC;

END
GO

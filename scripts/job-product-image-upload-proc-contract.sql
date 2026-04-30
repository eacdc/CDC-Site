/*
  Job product image upload — reference (stored procedure path, optional)
  ------------------------------------------------------------------------
  Current CDC implementation uploads to Cloudinary from Node, then runs:

    UPDATE dbo.JobBookingJobCard
    SET Jobcardproductimg = @secure_url
    WHERE JobBookingID = @id AND ...

  The block below documents an alternate DBA-only proc-based flow if you ever
  move binary handling back into SQL Server.

  Expected parameters (if using proc instead of app):

    @JobBookingID       INT
    @FileContent         VARBINARY(MAX)
    @OriginalFileName    NVARCHAR(260)
    @StoredFileName      NVARCHAR(255) OUTPUT  (optional)

  Example skeleton (not used by default Node route):

  CREATE OR ALTER PROCEDURE dbo.sp_CDC_JobProductImageUpload
    @JobBookingID INT,
    @FileContent VARBINARY(MAX),
    @OriginalFileName NVARCHAR(260),
    @StoredFileName NVARCHAR(255) OUTPUT
  AS
  BEGIN
    SET NOCOUNT ON;
    RAISERROR('DBA: implement or use Cloudinary path in CDC API', 16, 1);
  END
*/

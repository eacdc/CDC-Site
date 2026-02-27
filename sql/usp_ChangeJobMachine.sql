USE [IndusEnterprise]
GO

IF OBJECT_ID('dbo.usp_ChangeJobMachine', 'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_ChangeJobMachine;
GO

/*
  usp_ChangeJobMachine
  Moves one or more jobs from a source machine to a target machine by:
    1. Updating MachineID in JobScheduleRelease for matching non-complete rows
    2. Removing MachineJobSequenceOverride entries for the source machine
    3. Removing any stale MachineJobSequenceOverride entries on the target machine
    4. Running Auto_Schedule_Refresh to rebuild the schedule

  Parameters:
    @SourceMachineID  - The machine the jobs are currently assigned to
    @TargetMachineID  - The machine to reassign the jobs to
    @JobIdsJSON       - Plain JSON array of JobBookingJobCardContentsIDs, e.g. [123, 456]
*/
CREATE PROCEDURE [dbo].[usp_ChangeJobMachine]
    @SourceMachineID    INT,
    @TargetMachineID    INT,
    @JobIdsJSON         NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @SourceMachineID = @TargetMachineID
    BEGIN
        RAISERROR('Source and target machine must be different.', 16, 1);
        RETURN;
    END

    IF ISNULL(@JobIdsJSON, '') = ''
    BEGIN
        RAISERROR('No job IDs provided.', 16, 1);
        RETURN;
    END

    /* Parse job IDs from plain JSON array: [123, 456, ...] */
    IF OBJECT_ID('tempdb..#JobIds') IS NOT NULL DROP TABLE #JobIds;

    SELECT CAST(value AS INT) AS JobBookingJobCardContentsID
    INTO #JobIds
    FROM OPENJSON(@JobIdsJSON);

    IF NOT EXISTS (SELECT 1 FROM #JobIds)
    BEGIN
        RAISERROR('No valid job IDs found in the provided JSON.', 16, 1);
        RETURN;
    END

    /* Update machine assignment in JobScheduleRelease */
    UPDATE dbo.JobScheduleRelease
    SET MachineID = @TargetMachineID
    WHERE JobBookingJobCardContentsID IN (SELECT JobBookingJobCardContentsID FROM #JobIds)
      AND MachineID = @SourceMachineID
      AND ISNULL(IsDeletedTransaction, 0) = 0
      AND ISNULL(Status, '') <> 'Complete';

    /* Remove ordering overrides for these jobs on the source machine */
    DELETE FROM dbo.MachineJobSequenceOverride
    WHERE MachineID = @SourceMachineID
      AND JobBookingJobCardContentsID IN (SELECT JobBookingJobCardContentsID FROM #JobIds);

    /* Remove any stale overrides for these jobs on the target machine */
    DELETE FROM dbo.MachineJobSequenceOverride
    WHERE MachineID = @TargetMachineID
      AND JobBookingJobCardContentsID IN (SELECT JobBookingJobCardContentsID FROM #JobIds);

    /* Rebuild the schedule */
    EXEC dbo.Auto_Schedule_Refresh;

END
GO

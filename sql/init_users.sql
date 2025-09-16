IF OBJECT_ID('dbo.Users', 'U') IS NOT NULL
    DROP TABLE dbo.Users;
GO

CREATE TABLE dbo.Users (
	Id INT IDENTITY(1,1) PRIMARY KEY,
	UserId VARCHAR(100) NOT NULL UNIQUE,
	Username VARCHAR(200) NOT NULL,
	Password VARCHAR(200) NOT NULL,
	EmpId VARCHAR(50) NOT NULL
);
GO

INSERT INTO dbo.Users (UserId, Username, Password, EmpId)
VALUES ('testuser', 'Test User', 'Passw0rd!', 'EMP001');
GO



Backend (Node.js + Express + MSSQL)

Setup

1. Create database table and test user
- Open SQL Server Management Studio (SSMS)
- Run the script in `sql/init_users.sql` against your database

2. Configure environment variables in `.env`

```
PORT=3001
DB_USER=your_sql_user
DB_PASSWORD=your_sql_password
DB_NAME=your_database_name
DB_SERVER=localhost\\SQLEXPRESS
```

3. Start the server

```
npm start
```

API

- POST `/api/auth/login`
  - body: `{ "userId": "testuser", "password": "Passw0rd!" }`
  - response: `{ "username": "Test User", "userId": "testuser", "empId": "EMP001" }`



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

# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/contractor-po-system
MONGODB_URI_VT=mongodb://localhost:27017/voice-tool

# OpenAI Configuration (Required for Voice Note Tool AI analysis)
OPENAI_API_KEY=your_openai_api_key_here

# JWT Secret
JWT_SECRET=your_jwt_secret_here
```

**Note:** To use the Voice Note Tool's AI analysis feature, you need to:
1. Sign up for an OpenAI API account at https://platform.openai.com/
2. Create an API key from your OpenAI dashboard
3. Add the API key to your `.env` file as `OPENAI_API_KEY`

3. Start the server

```
npm start
```

API

- POST `/api/auth/login`
  - body: `{ "userId": "testuser", "password": "Passw0rd!" }`
  - response: `{ "username": "Test User", "userId": "testuser", "empId": "EMP001" }`



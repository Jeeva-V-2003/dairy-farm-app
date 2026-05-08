# Dairy Farm App - Server

Backend API for the Dairy Farm Management Application. Built with Node.js, Express, and PostgreSQL.

## Prerequisites

- Node.js (v16 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

## Environment Variables

Create a `.env` file in the `server/` directory based on `.env.example`:

```bash
cp .env.example .env
```

Required environment variables:

- `DATABASE_URL` - PostgreSQL connection string (e.g., `postgresql://user:password@host:5432/dbname`)
- `JWT_SECRET` - Secret key for JWT token generation (use a long random string)
- `PORT` - Server port (default: 4000)
- `UPLOADS_DIR` - Directory for file uploads (optional, defaults to `server/uploads`)

## Installation

1. Install dependencies:

```bash
npm install
```

2. Set up PostgreSQL database:

```bash
# Create a new PostgreSQL database
createdb dairy_farm

# Or using psql:
psql -U postgres
CREATE DATABASE dairy_farm;
\q
```

3. Update your `.env` file with the correct `DATABASE_URL`:

```
DATABASE_URL=postgresql://postgres:your-password@localhost:5432/dairy_farm
```

## Database Migration (from SQLite)

If you're migrating from an existing SQLite database:

1. Ensure your `.env` file has the correct `DATABASE_URL` for PostgreSQL

2. Run the migration script:

```bash
SQLITE_PATH=/path/to/dairy-farm.db npm run migrate
```

Or with explicit paths:

```bash
SQLITE_PATH=./data/dairy-farm.db DATABASE_URL=postgresql://user:pass@host:5432/dbname node src/db-migrate.js
```

The migration script will:
- Read all data from the SQLite database
- Create tables in PostgreSQL (if they don't exist)
- Migrate all records in the correct foreign key order
- Reset auto-increment sequences
- Provide a detailed summary of migrated data

The script is idempotent and safe to run multiple times.

## Running the Server

### Development mode (with auto-reload):

```bash
npm run dev
```

### Production mode:

```bash
npm start
```

The server will start on `http://localhost:4000` (or the port specified in `PORT` env var).

## Database Schema

The application uses the following tables:

- `users` - User authentication
- `cows` - Cow records
- `calves` - Calf records
- `buyers` - Milk buyers
- `expense_categories` - Expense categories
- `food_items` - Feed/food items
- `food_price_history` - Historical pricing for feed items
- `daily_entries` - Daily farm entries (milk production, sales, expenses)
- `cow_milk_entries` - Individual cow milk production records
- `milk_sales` - Milk sales transactions
- `expenses` - Daily expenses
- `calf_expenses` - Calf-specific expenses
- `investments` - Investment tracking
- `cow_update_history` - Audit log for cow record changes

## API Endpoints

All endpoints (except `/api/auth/*`) require JWT authentication via `Authorization: Bearer <token>` header.

### Authentication

- `POST /api/auth/register` - Register new user (single-user system)
- `POST /api/auth/login` - Login and get JWT token
- `GET /api/auth/status` - Check if user exists

### Core Resources

- `GET /api/bootstrap` - Get all initial data (dashboard, cows, calves, etc.)
- `GET /api/dashboard` - Get dashboard statistics
- `GET /api/daily-entries` - Get recent daily entries
- `POST /api/daily-entries` - Create or update daily entry
- `DELETE /api/daily-entries/:id` - Delete daily entry

### Cows

- `POST /api/cows` - Create new cow
- `PUT /api/cows/:id` - Update cow
- `DELETE /api/cows/:id` - Delete cow
- `GET /api/cows/:id/history` - Get cow update history

### Calves

- `GET /api/calves` - Get all calves
- `POST /api/calves` - Create new calf
- `PUT /api/calves/:id` - Update calf
- `DELETE /api/calves/:id` - Delete calf
- `POST /api/calves/:id/expenses` - Add calf expense
- `DELETE /api/calf-expenses/:id` - Delete calf expense
- `POST /api/calves/:id/transfer` - Transfer calf to cow section

### Other Resources

- Buyers: `GET|POST /api/buyers`, `PUT|DELETE /api/buyers/:id`
- Categories: `GET|POST /api/categories`, `PUT|DELETE /api/categories/:id`
- Foods: `GET|POST /api/foods`, `PUT|DELETE /api/foods/:id`
- Investments: `GET|POST /api/investments`, `PUT|DELETE /api/investments/:id`
- Reports: `GET /api/reports?start=YYYY-MM-DD&end=YYYY-MM-DD`
- Export: `GET /api/export/json`
- Account: `DELETE /api/account` - Delete all data

## Development

### Database Inspection

Connect to your PostgreSQL database:

```bash
psql $DATABASE_URL
```

Useful commands:

```sql
-- List all tables
\dt

-- Describe a table
\d table_name

-- View data
SELECT * FROM cows LIMIT 10;

-- Check row counts
SELECT
  schemaname,
  tablename,
  n_live_tup as row_count
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
```

### Resetting the Database

To start fresh:

```sql
DROP DATABASE dairy_farm;
CREATE DATABASE dairy_farm;
```

The application will recreate all tables on next startup.

## Troubleshooting

### Connection Issues

- Verify PostgreSQL is running: `pg_isready`
- Check connection string format: `postgresql://user:password@host:port/database`
- Ensure database exists: `psql -l`
- Check firewall settings if connecting to remote database

### Migration Issues

- Ensure SQLite database path is correct
- Check PostgreSQL connection is working
- Review migration script output for specific errors
- Verify both `better-sqlite3` and `pg` are installed

### SSL/TLS Issues

For production PostgreSQL (like Railway, Heroku):

```
DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require
```

The app automatically enables SSL in production (`NODE_ENV=production`).

## License

MIT

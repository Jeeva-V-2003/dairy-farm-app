# Deployment Guide

This app is configured for split deployment with frontend and backend on separate hosts, using PostgreSQL as the database.

## Recommended: Vercel + Railway (Free Tier)

- **Frontend:** Vercel (static Vite app)
- **Backend:** Railway (Node.js + PostgreSQL)
- **Database:** PostgreSQL on Railway (free tier available)
- **Uploads:** Persistent storage on Railway

### Why this setup?

- Vercel provides excellent static hosting for the Vite frontend
- Railway's free tier supports both Node.js and PostgreSQL
- PostgreSQL provides better scalability than SQLite
- Railway handles persistent storage for uploads
- Both platforms have generous free tiers

---

## 1. Production Code Behavior

### Backend

The server now:
- Uses PostgreSQL via the `pg` library with async/await
- Serves `client/dist` automatically when present (single-service deployment)
- Keeps `/api/*` and `/uploads/*` on the backend
- Falls back to `client/dist/index.html` for app routes
- Supports `UPLOADS_DIR` for persistent file storage

### Database

The application now uses PostgreSQL:
- Connection via `DATABASE_URL` environment variable
- Automatic schema initialization on startup
- Foreign key constraints enforced at database level
- Better performance and scalability than SQLite
- Support for concurrent connections

### Frontend API

The client supports:
- Same-origin API calls by default (for single-service deployment)
- Optional remote backend via `VITE_API_URL` (for split deployment)

Example:
```env
VITE_API_URL=https://your-server.up.railway.app
```

---

## 2. Required Environment Variables

### Backend (Railway)

```env
PORT=4000
DATABASE_URL=postgresql://user:password@host:5432/database
JWT_SECRET=replace-this-with-a-long-random-secret
UPLOADS_DIR=/app/uploads
NODE_ENV=production
```

### Frontend (Vercel)

```env
VITE_API_URL=https://your-server.up.railway.app
```

---

## 3. Deploy Backend on Railway

### Step 1: Create Railway Account

1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Create a new project

### Step 2: Add PostgreSQL Database

1. In your Railway project, click **"+ New"**
2. Select **"Database"** → **"PostgreSQL"**
3. Railway will provision a PostgreSQL instance
4. Copy the `DATABASE_URL` from the PostgreSQL service variables

### Step 3: Deploy Backend Service

1. Click **"+ New"** → **"GitHub Repo"**
2. Select your dairy-farm-app repository
3. Configure the service:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`

### Step 4: Set Environment Variables

In the Railway backend service, add these variables:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=your-long-random-secret-here
UPLOADS_DIR=/app/uploads
NODE_ENV=production
PORT=4000
```

Note: Railway automatically provides `PORT` and PostgreSQL connection, but you should set them explicitly for clarity.

### Step 5: Deploy

Railway will automatically deploy on every push to your main branch.

Your backend URL will be something like:
```
https://your-app-name.up.railway.app
```

### Step 6: Migrate Data (Optional)

If you have existing SQLite data to migrate:

1. Install Railway CLI:
   ```bash
   npm i -g @railway/cli
   railway login
   ```

2. Link to your project:
   ```bash
   cd server
   railway link
   ```

3. Run migration locally (connecting to Railway PostgreSQL):
   ```bash
   railway run node src/db-migrate.js
   ```

   Or set environment variables manually:
   ```bash
   SQLITE_PATH=./data/dairy-farm.db \
   DATABASE_URL=postgresql://user:pass@host:5432/db \
   node src/db-migrate.js
   ```

---

## 4. Deploy Frontend on Vercel

### Step 1: Import Project

1. Go to [vercel.com](https://vercel.com)
2. Import your GitHub repository
3. Configure project settings:
   - **Root Directory:** `client`
   - **Framework Preset:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`

### Step 2: Add Environment Variables

Add this environment variable in Vercel:

```env
VITE_API_URL=https://your-app-name.up.railway.app
```

Replace with your actual Railway backend URL.

### Step 3: Deploy

Vercel will automatically deploy on every push to your main branch.

Your frontend URL will be something like:
```
https://your-app-name.vercel.app
```

---

## 5. Database Migration Script

To migrate existing SQLite data to PostgreSQL, use the provided migration script:

```bash
cd server

# Install dependencies (if not already installed)
npm install

# Run migration
SQLITE_PATH=/path/to/dairy-farm.db \
DATABASE_URL=postgresql://user:pass@host:5432/db \
node src/db-migrate.js
```

The migration script:
- Reads all data from SQLite database (read-only mode)
- Migrates tables in correct foreign key order
- Uses `ON CONFLICT DO NOTHING` for idempotency
- Resets PostgreSQL sequences after migration
- Provides detailed progress and summary

**Safe to run multiple times** - the script is idempotent.

---

## 6. Environment Setup Summary

### Backend Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | Secret key for JWT tokens | Long random string |
| `PORT` | Server port | `4000` |
| `UPLOADS_DIR` | Directory for file uploads | `/app/uploads` |
| `NODE_ENV` | Environment mode | `production` |

### Frontend Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_API_URL` | Backend API URL | `https://your-app.up.railway.app` |

---

## 7. Local Development

### Backend

1. Install PostgreSQL locally
2. Create database:
   ```bash
   createdb dairy_farm
   ```

3. Create `.env` file in `server/`:
   ```env
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dairy_farm
   JWT_SECRET=dev-secret
   PORT=4000
   ```

4. Run server:
   ```bash
   cd server
   npm install
   npm run dev
   ```

### Frontend

1. Create `.env` file in `client/`:
   ```env
   VITE_API_URL=http://localhost:4000
   ```

2. Run dev server:
   ```bash
   cd client
   npm install
   npm run dev
   ```

---

## 8. Important Notes

### PostgreSQL vs SQLite

This application has been migrated from SQLite to PostgreSQL for:
- Better scalability and concurrent access
- Cloud deployment compatibility
- Advanced features (transactions, constraints)
- Production-grade reliability

### Concurrent Connections

Unlike SQLite, PostgreSQL supports multiple simultaneous connections:
- You can scale to multiple backend instances if needed
- Connection pooling is handled automatically by `pg`
- Railway's free tier supports up to 100 concurrent connections

### Backup Strategy

For Railway PostgreSQL:
1. Use Railway's built-in backup features
2. Export data via API: `GET /api/export/json`
3. Use `pg_dump` for database backups:
   ```bash
   railway run pg_dump > backup.sql
   ```

### CORS Configuration

The backend currently uses permissive CORS settings. For production, consider restricting to your Vercel domain:

```javascript
app.use(cors({
  origin: 'https://your-app.vercel.app'
}));
```

### Cost Considerations

Both platforms offer generous free tiers:

**Railway Free Tier:**
- $5 worth of usage per month
- Includes PostgreSQL database
- Persistent storage included
- Auto-sleep after inactivity

**Vercel Free Tier:**
- 100 GB bandwidth/month
- Unlimited deployments
- Automatic HTTPS

---

## 9. Troubleshooting

### Database Connection Issues

If you see "connection refused" errors:
1. Verify `DATABASE_URL` is set correctly
2. Check PostgreSQL service is running in Railway
3. Ensure Railway services are linked properly
4. Check Railway logs for connection errors

### Migration Errors

If the migration script fails:
1. Verify both SQLite and PostgreSQL connections
2. Check that `better-sqlite3` and `pg` are installed
3. Review script output for specific table errors
4. Ensure target database is empty or use `ON CONFLICT DO NOTHING`

### Upload Storage Issues

If uploads aren't persisting:
1. Verify `UPLOADS_DIR` environment variable is set
2. Check Railway volume is mounted correctly
3. Ensure write permissions on upload directory

### API Connection from Frontend

If frontend can't reach backend:
1. Verify `VITE_API_URL` is set in Vercel
2. Check CORS settings in backend
3. Ensure Railway backend is deployed and running
4. Check browser console for CORS errors

---

## 10. Deployment Checklist

- [ ] Backend deployed on Railway
- [ ] PostgreSQL database provisioned
- [ ] Environment variables set in Railway
- [ ] Backend URL accessible
- [ ] Data migrated (if applicable)
- [ ] Frontend deployed on Vercel
- [ ] `VITE_API_URL` configured in Vercel
- [ ] Frontend can connect to backend
- [ ] Login/register works
- [ ] Data persistence verified
- [ ] File uploads work
- [ ] Export functionality tested

---

## 11. Alternative Deployment Options

### Single-Service Deployment (Railway Only)

You can deploy both frontend and backend on Railway:

1. Build the frontend:
   ```bash
   cd client
   npm run build
   ```

2. Deploy `server` directory to Railway
3. The server will automatically serve the built frontend
4. No need for separate Vercel deployment
5. Set `DATABASE_URL` and `JWT_SECRET` in Railway

This approach is simpler but uses more Railway resources.

### Other PostgreSQL Providers

Instead of Railway's PostgreSQL, you can use:
- **Neon** (serverless PostgreSQL, generous free tier)
- **Supabase** (includes auth and storage)
- **ElephantSQL** (managed PostgreSQL)
- **AWS RDS** (for production scale)

Just update the `DATABASE_URL` to point to your provider.

---

## Support

For issues or questions:
1. Check the server logs in Railway dashboard
2. Review the API responses in browser DevTools
3. Verify all environment variables are set correctly
4. Consult the `server/README.md` for detailed API documentation

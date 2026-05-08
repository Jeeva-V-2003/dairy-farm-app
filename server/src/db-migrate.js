#!/usr/bin/env node

/**
 * SQLite to PostgreSQL Data Migration Script
 *
 * This script migrates all data from an existing SQLite database to PostgreSQL.
 * It is idempotent and safe to run multiple times.
 *
 * Usage:
 *   SQLITE_PATH=/path/to/dairy-farm.db DATABASE_URL=postgresql://... node src/db-migrate.js
 *
 * Environment Variables:
 *   SQLITE_PATH - Path to the existing SQLite database file
 *   DATABASE_URL - PostgreSQL connection string
 */

const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Configuration
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'dairy-farm.db');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  console.error('Example: DATABASE_URL=postgresql://user:password@host:5432/dbname node src/db-migrate.js');
  process.exit(1);
}

if (!fs.existsSync(SQLITE_PATH)) {
  console.error(`ERROR: SQLite database not found at: ${SQLITE_PATH}`);
  console.error('Set SQLITE_PATH environment variable to the correct path');
  process.exit(1);
}

console.log('='.repeat(60));
console.log('SQLite to PostgreSQL Migration');
console.log('='.repeat(60));
console.log(`Source (SQLite): ${SQLITE_PATH}`);
console.log(`Target (PostgreSQL): ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}`);
console.log('='.repeat(60));
console.log('');

// Open databases
const sqlite = new Database(SQLITE_PATH, { readonly: true });
const pool = new Pool({ connectionString: DATABASE_URL });

// Migration stats
const stats = {
  tables: {},
  errors: []
};

async function migrateTable(tableName, sqliteRows, pgClient, options = {}) {
  const { skipColumns = [], transformRow = (row) => row } = options;

  if (sqliteRows.length === 0) {
    console.log(`  ├─ ${tableName}: 0 rows (skipped)`);
    stats.tables[tableName] = 0;
    return;
  }

  let migrated = 0;
  let skipped = 0;

  for (const row of sqliteRows) {
    try {
      const transformedRow = transformRow(row);
      const columns = Object.keys(transformedRow).filter(col => !skipColumns.includes(col));
      const values = columns.map(col => transformedRow[col]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

      const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      const result = await pgClient.query(sql, values);

      if (result.rowCount > 0) {
        migrated++;
      } else {
        skipped++;
      }
    } catch (error) {
      stats.errors.push({ table: tableName, row, error: error.message });
      console.error(`    ⚠ Error migrating row in ${tableName}:`, error.message);
    }
  }

  stats.tables[tableName] = migrated;
  console.log(`  ├─ ${tableName}: ${migrated} rows migrated, ${skipped} skipped`);
}

async function resetSequence(tableName, idColumn, pgClient) {
  try {
    await pgClient.query(`
      SELECT setval(
        pg_get_serial_sequence('${tableName}', '${idColumn}'),
        COALESCE((SELECT MAX(${idColumn}) FROM ${tableName}), 1)
      )
    `);
  } catch (error) {
    console.error(`    ⚠ Error resetting sequence for ${tableName}:`, error.message);
  }
}

async function migrate() {
  const pgClient = await pool.connect();

  try {
    console.log('Starting migration...\n');

    // Migrate tables in FK order
    console.log('Migrating tables:');

    // 1. Users
    const users = sqlite.prepare('SELECT * FROM users').all();
    await migrateTable('users', users, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        created_at: row.created_at || new Date().toISOString()
      })
    });
    await resetSequence('users', 'id', pgClient);

    // 2. Expense categories
    const categories = sqlite.prepare('SELECT * FROM expense_categories').all();
    await migrateTable('expense_categories', categories, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        is_default: row.is_default === 1,
        created_at: row.created_at || new Date().toISOString()
      })
    });
    await resetSequence('expense_categories', 'id', pgClient);

    // 3. Food items
    const foods = sqlite.prepare('SELECT * FROM food_items').all();
    await migrateTable('food_items', foods, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        purchase_kg: row.purchase_kg || 0,
        purchase_amount: row.purchase_amount || 0,
        rate_per_kg: row.rate_per_kg || 0,
        unit_type: row.unit_type || 'kg',
        created_at: row.created_at || new Date().toISOString()
      })
    });
    await resetSequence('food_items', 'id', pgClient);

    // 4. Food price history
    const foodHistory = sqlite.prepare('SELECT * FROM food_price_history').all();
    await migrateTable('food_price_history', foodHistory, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        purchase_quantity: row.purchase_quantity || 0,
        purchase_amount: row.purchase_amount || 0,
        unit_rate: row.unit_rate || 0,
        unit_type: row.unit_type || 'kg',
        created_at: row.created_at || new Date().toISOString()
      })
    });
    await resetSequence('food_price_history', 'id', pgClient);

    // 5. Cows
    const cows = sqlite.prepare('SELECT * FROM cows').all();
    await migrateTable('cows', cows, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        created_at: row.created_at || new Date().toISOString()
      })
    });
    await resetSequence('cows', 'id', pgClient);

    // 6. Calves
    const calves = sqlite.prepare('SELECT * FROM calves').all();
    await migrateTable('calves', calves, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        purchase_price: row.purchase_price || 0,
        paid_amount: row.paid_amount || 0,
        created_at: row.created_at || new Date().toISOString()
      })
    });
    await resetSequence('calves', 'id', pgClient);

    // 7. Buyers
    const buyers = sqlite.prepare('SELECT * FROM buyers').all();
    await migrateTable('buyers', buyers, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        default_rate: row.default_rate || 0,
        active: row.active === 1,
        created_at: row.created_at || new Date().toISOString()
      })
    });
    await resetSequence('buyers', 'id', pgClient);

    // 8. Daily entries
    const dailyEntries = sqlite.prepare('SELECT * FROM daily_entries').all();
    await migrateTable('daily_entries', dailyEntries, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        total_milk_litres: row.total_milk_litres || 0,
        remaining_milk_litres: row.remaining_milk_litres || 0,
        total_income: row.total_income || 0,
        total_expenses: row.total_expenses || 0,
        profit: row.profit || 0,
        created_at: row.created_at || new Date().toISOString(),
        updated_at: row.updated_at || new Date().toISOString()
      })
    });
    await resetSequence('daily_entries', 'id', pgClient);

    // 9. Cow milk entries
    const cowMilkEntries = sqlite.prepare('SELECT * FROM cow_milk_entries').all();
    await migrateTable('cow_milk_entries', cowMilkEntries, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        morning_litres: row.morning_litres || 0,
        evening_litres: row.evening_litres || 0,
        total_litres: row.total_litres || 0
      })
    });
    await resetSequence('cow_milk_entries', 'id', pgClient);

    // 10. Milk sales
    const milkSales = sqlite.prepare('SELECT * FROM milk_sales').all();
    await migrateTable('milk_sales', milkSales, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        litres: row.litres || 0,
        rate_per_litre: row.rate_per_litre || 0,
        income: row.income || 0,
        payment_mode: row.payment_mode || 'Cash',
        entry_shift: row.entry_shift || 'Morning'
      })
    });
    await resetSequence('milk_sales', 'id', pgClient);

    // 11. Expenses
    const expenses = sqlite.prepare('SELECT * FROM expenses').all();
    await migrateTable('expenses', expenses, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        expense_type: row.expense_type || 'common',
        quantity_kg: row.quantity_kg || 0,
        unit_rate: row.unit_rate || 0,
        amount: row.amount || 0,
        created_at: row.created_at || new Date().toISOString()
      })
    });
    await resetSequence('expenses', 'id', pgClient);

    // 12. Calf expenses
    const calfExpenses = sqlite.prepare('SELECT * FROM calf_expenses').all();
    await migrateTable('calf_expenses', calfExpenses, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        expense_type: row.expense_type || 'food',
        quantity_kg: row.quantity_kg || 0,
        unit_rate: row.unit_rate || 0,
        amount: row.amount || 0,
        payment_mode: row.payment_mode || 'Cash',
        created_at: row.created_at || new Date().toISOString()
      })
    });
    await resetSequence('calf_expenses', 'id', pgClient);

    // 13. Investments
    const investments = sqlite.prepare('SELECT * FROM investments').all();
    await migrateTable('investments', investments, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        source_type: row.source_type || 'manual',
        investment_amount: row.investment_amount || 0,
        status: row.status || 'active',
        created_at: row.created_at || new Date().toISOString(),
        updated_at: row.updated_at || new Date().toISOString()
      })
    });
    await resetSequence('investments', 'id', pgClient);

    // 14. Cow update history
    const cowHistory = sqlite.prepare('SELECT * FROM cow_update_history').all();
    await migrateTable('cow_update_history', cowHistory, pgClient, {
      skipColumns: ['id'],
      transformRow: (row) => ({
        ...row,
        updated_at: row.updated_at || new Date().toISOString()
      })
    });
    await resetSequence('cow_update_history', 'id', pgClient);

    console.log('\n' + '='.repeat(60));
    console.log('Migration Summary:');
    console.log('='.repeat(60));

    let totalMigrated = 0;
    for (const [table, count] of Object.entries(stats.tables)) {
      totalMigrated += count;
      console.log(`  ${table.padEnd(25)} ${count.toString().padStart(6)} rows`);
    }

    console.log('='.repeat(60));
    console.log(`Total rows migrated: ${totalMigrated}`);

    if (stats.errors.length > 0) {
      console.log(`Total errors: ${stats.errors.length}`);
      console.log('\nErrors encountered:');
      stats.errors.forEach((err, i) => {
        console.log(`  ${i + 1}. ${err.table}: ${err.error}`);
      });
    } else {
      console.log('No errors encountered ✓');
    }

    console.log('='.repeat(60));
    console.log('\nMigration completed successfully! ✓');
    console.log('You can now start your application with PostgreSQL.\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  } finally {
    pgClient.release();
    sqlite.close();
    await pool.end();
  }
}

// Run migration
migrate()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

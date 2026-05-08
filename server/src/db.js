const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const defaultExpenseCategories = [
  'Feed 1', 'Feed 2', 'Feed 3', 'Feed 4', 'Medical expense', 'Labour', 'Transport', 'Electricity', 'Maintenance', 'Cow purchase', 'Other expense'
];

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create all tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS cows (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        breed TEXT,
        age TEXT,
        status TEXT DEFAULT 'Active',
        purchase_date TEXT,
        status_date TEXT,
        purchase_price NUMERIC,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS buyers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        location TEXT,
        default_rate NUMERIC DEFAULT 0,
        contact TEXT,
        notes TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS expense_categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS food_items (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        purchase_kg NUMERIC DEFAULT 0,
        purchase_amount NUMERIC DEFAULT 0,
        rate_per_kg NUMERIC DEFAULT 0,
        unit_type TEXT DEFAULT 'kg',
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS food_price_history (
        id SERIAL PRIMARY KEY,
        food_item_id INTEGER NOT NULL,
        purchase_quantity NUMERIC DEFAULT 0,
        purchase_amount NUMERIC DEFAULT 0,
        unit_rate NUMERIC DEFAULT 0,
        unit_type TEXT DEFAULT 'kg',
        effective_from TEXT NOT NULL,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        FOREIGN KEY(food_item_id) REFERENCES food_items(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS calves (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        breed TEXT,
        birth_date TEXT,
        source_type TEXT DEFAULT 'raised',
        expected_lactation_date TEXT,
        purchase_price NUMERIC DEFAULT 0,
        paid_amount NUMERIC DEFAULT 0,
        status TEXT DEFAULT 'Growing',
        notes TEXT,
        transferred_to_cow_id INTEGER,
        transferred_at TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        FOREIGN KEY(transferred_to_cow_id) REFERENCES cows(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS calf_expenses (
        id SERIAL PRIMARY KEY,
        calf_id INTEGER NOT NULL,
        expense_date TEXT NOT NULL,
        expense_type TEXT DEFAULT 'food',
        category_id INTEGER,
        food_item_id INTEGER,
        food_price_history_id INTEGER,
        food_name_snapshot TEXT,
        unit_type_snapshot TEXT,
        rate_effective_from TEXT,
        quantity_kg NUMERIC DEFAULT 0,
        unit_rate NUMERIC DEFAULT 0,
        amount NUMERIC DEFAULT 0,
        entry_shift TEXT,
        description TEXT,
        payment_mode TEXT DEFAULT 'Cash',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        FOREIGN KEY(calf_id) REFERENCES calves(id) ON DELETE CASCADE,
        FOREIGN KEY(category_id) REFERENCES expense_categories(id) ON DELETE SET NULL,
        FOREIGN KEY(food_item_id) REFERENCES food_items(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS daily_entries (
        id SERIAL PRIMARY KEY,
        entry_date TEXT NOT NULL UNIQUE,
        total_milk_litres NUMERIC DEFAULT 0,
        remaining_milk_litres NUMERIC DEFAULT 0,
        total_income NUMERIC DEFAULT 0,
        total_expenses NUMERIC DEFAULT 0,
        profit NUMERIC DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS cow_milk_entries (
        id SERIAL PRIMARY KEY,
        daily_entry_id INTEGER NOT NULL,
        cow_id INTEGER NOT NULL,
        morning_litres NUMERIC DEFAULT 0,
        evening_litres NUMERIC DEFAULT 0,
        total_litres NUMERIC DEFAULT 0,
        entry_shift TEXT,
        status TEXT DEFAULT 'Milked',
        notes TEXT,
        FOREIGN KEY(daily_entry_id) REFERENCES daily_entries(id) ON DELETE CASCADE,
        FOREIGN KEY(cow_id) REFERENCES cows(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS milk_sales (
        id SERIAL PRIMARY KEY,
        daily_entry_id INTEGER NOT NULL,
        buyer_id INTEGER,
        litres NUMERIC DEFAULT 0,
        rate_per_litre NUMERIC DEFAULT 0,
        income NUMERIC DEFAULT 0,
        payment_status TEXT DEFAULT 'Paid',
        payment_mode TEXT DEFAULT 'Cash',
        entry_shift TEXT DEFAULT 'Morning',
        notes TEXT,
        FOREIGN KEY(daily_entry_id) REFERENCES daily_entries(id) ON DELETE CASCADE,
        FOREIGN KEY(buyer_id) REFERENCES buyers(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        daily_entry_id INTEGER,
        category_id INTEGER,
        expense_type TEXT DEFAULT 'common',
        cow_id INTEGER,
        food_item_id INTEGER,
        food_price_history_id INTEGER,
        food_name_snapshot TEXT,
        unit_type_snapshot TEXT,
        rate_effective_from TEXT,
        quantity_kg NUMERIC DEFAULT 0,
        unit_rate NUMERIC DEFAULT 0,
        amount NUMERIC DEFAULT 0,
        entry_shift TEXT,
        description TEXT,
        payment_mode TEXT,
        bill_path TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        FOREIGN KEY(daily_entry_id) REFERENCES daily_entries(id) ON DELETE CASCADE,
        FOREIGN KEY(category_id) REFERENCES expense_categories(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS investments (
        id SERIAL PRIMARY KEY,
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_id INTEGER,
        title TEXT NOT NULL,
        investment_date TEXT NOT NULL,
        investment_amount NUMERIC DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        completed_on TEXT,
        completed_income_amount NUMERIC,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS cow_update_history (
        id SERIAL PRIMARY KEY,
        cow_id INTEGER NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        changes TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        FOREIGN KEY(cow_id) REFERENCES cows(id) ON DELETE CASCADE
      );
    `);

    // Create indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_investments_status_date ON investments(status, investment_date)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_food_price_history_food_effective ON food_price_history(food_item_id, effective_from DESC)');

    // Safe migrations: Add columns if they don't exist
    // (PostgreSQL supports ALTER TABLE ADD COLUMN IF NOT EXISTS since version 9.6)

    // All columns should exist from the CREATE TABLE statements above
    // But we keep this pattern for future migrations

    // Insert default expense categories
    for (const name of defaultExpenseCategories) {
      await client.query(
        'INSERT INTO expense_categories (name, is_default) VALUES ($1, true) ON CONFLICT (name) DO NOTHING',
        [name]
      );
    }

    // Migrate food_items without history to food_price_history
    const foodsWithoutHistory = await client.query(`
      SELECT fi.*
      FROM food_items fi
      LEFT JOIN food_price_history fph ON fph.food_item_id = fi.id
      WHERE fph.id IS NULL
    `);

    for (const food of foodsWithoutHistory.rows) {
      await client.query(`
        INSERT INTO food_price_history (food_item_id, purchase_quantity, purchase_amount, unit_rate, unit_type, effective_from, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING
      `, [
        food.id,
        Number(food.purchase_kg || 0),
        Number(food.purchase_amount || 0),
        Number(food.rate_per_kg || 0),
        food.unit_type || 'kg',
        food.created_at || new Date().toISOString(),
        food.notes || ''
      ]);
    }

    // Get existing history keys to avoid duplicates
    const existingHistory = await client.query(
      'SELECT food_item_id, effective_from, unit_rate, unit_type FROM food_price_history'
    );
    const existingHistoryKeys = new Set(
      existingHistory.rows.map((row) =>
        `${row.food_item_id}::${row.effective_from}::${Number(row.unit_rate || 0).toFixed(4)}::${row.unit_type || 'kg'}`
      )
    );

    // Migrate historical expense rates
    const historicalExpenseRates = await client.query(`
      SELECT DISTINCT
        e.food_item_id,
        COALESCE(e.quantity_kg, 0) AS purchase_quantity,
        COALESCE(e.amount, 0) AS purchase_amount,
        COALESCE(e.unit_rate, 0) AS unit_rate,
        COALESCE(e.unit_type_snapshot, fi.unit_type, 'kg') AS unit_type,
        (d.entry_date || ' 23:59:59') AS effective_from,
        e.description AS notes
      FROM expenses e
      JOIN daily_entries d ON d.id = e.daily_entry_id
      LEFT JOIN food_items fi ON fi.id = e.food_item_id
      WHERE e.expense_type = 'feed' AND e.food_item_id IS NOT NULL AND COALESCE(e.unit_rate, 0) > 0
    `);

    const historicalCalfRates = await client.query(`
      SELECT DISTINCT
        ce.food_item_id,
        COALESCE(ce.quantity_kg, 0) AS purchase_quantity,
        COALESCE(ce.amount, 0) AS purchase_amount,
        COALESCE(ce.unit_rate, 0) AS unit_rate,
        COALESCE(ce.unit_type_snapshot, fi.unit_type, 'kg') AS unit_type,
        (ce.expense_date || ' 23:59:59') AS effective_from,
        ce.description AS notes
      FROM calf_expenses ce
      LEFT JOIN food_items fi ON fi.id = ce.food_item_id
      WHERE ce.expense_type = 'feed' AND ce.food_item_id IS NOT NULL AND COALESCE(ce.unit_rate, 0) > 0
    `);

    const allHistoricalRates = [...historicalExpenseRates.rows, ...historicalCalfRates.rows];

    for (const row of allHistoricalRates) {
      const key = `${row.food_item_id}::${row.effective_from}::${Number(row.unit_rate || 0).toFixed(4)}::${row.unit_type || 'kg'}`;
      if (existingHistoryKeys.has(key)) continue;

      await client.query(`
        INSERT INTO food_price_history (food_item_id, purchase_quantity, purchase_amount, unit_rate, unit_type, effective_from, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING
      `, [
        row.food_item_id,
        Number(row.purchase_quantity || 0),
        Number(row.purchase_amount || 0),
        Number(row.unit_rate || 0),
        row.unit_type || 'kg',
        row.effective_from,
        row.notes || ''
      ]);

      existingHistoryKeys.add(key);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb, defaultExpenseCategories };

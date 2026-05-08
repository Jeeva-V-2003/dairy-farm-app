const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const dayjs = require('dayjs');
const { pool, initDb } = require('./db');

// Initialize database (async IIFE wrapper for CommonJS)
(async () => {
  try {
    await initDb();
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
})();

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'milk-business-pro-reset-2026-05-01-v2';
const uploadsDir = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir });

app.use(cors());
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));
app.use('/uploads', express.static(uploadsDir));

const clientDistPath = path.join(__dirname, '..', '..', 'client', 'dist');
const hasClientBuild = fs.existsSync(path.join(clientDistPath, 'index.html'));
if (hasClientBuild) {
  app.use(express.static(clientDistPath));
}

const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, status, message) => res.status(status).json({ success: false, message });

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return fail(res, 401, 'Authentication required');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return fail(res, 401, 'Invalid token');
  }
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 400, errors.array()[0].msg);
  next();
}

async function getSingleValue(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

function normalizeLookupTimestamp(value) {
  if (!value) return dayjs().toISOString();
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return dayjs(raw).endOf('day').toISOString();
  const parsed = dayjs(raw);
  return parsed.isValid() ? parsed.toISOString() : dayjs().toISOString();
}

async function getFoodPriceHistoryRows(foodId) {
  const result = await pool.query(
    'SELECT * FROM food_price_history WHERE food_item_id = $1 ORDER BY effective_from DESC, id DESC',
    [foodId]
  );
  return result.rows;
}

async function resolveFoodRateSnapshot(foodId, atValue) {
  if (!foodId) return null;
  const lookupAt = normalizeLookupTimestamp(atValue);

  const history = await getSingleValue(`
    SELECT fph.*, fi.name AS food_name
    FROM food_price_history fph
    JOIN food_items fi ON fi.id = fph.food_item_id
    WHERE fph.food_item_id = $1 AND fph.effective_from <= $2
    ORDER BY fph.effective_from DESC, fph.id DESC
    LIMIT 1
  `, [foodId, lookupAt]);

  if (history) {
    return {
      food_price_history_id: history.id,
      food_name_snapshot: history.food_name,
      unit_type_snapshot: history.unit_type || 'kg',
      unit_rate: Number(history.unit_rate || 0),
      rate_effective_from: history.effective_from
    };
  }

  const oldestHistory = await getSingleValue(`
    SELECT fph.*, fi.name AS food_name
    FROM food_price_history fph
    JOIN food_items fi ON fi.id = fph.food_item_id
    WHERE fph.food_item_id = $1
    ORDER BY fph.effective_from ASC, fph.id ASC
    LIMIT 1
  `, [foodId]);

  if (oldestHistory) {
    return {
      food_price_history_id: oldestHistory.id,
      food_name_snapshot: oldestHistory.food_name,
      unit_type_snapshot: oldestHistory.unit_type || 'kg',
      unit_rate: Number(oldestHistory.unit_rate || 0),
      rate_effective_from: oldestHistory.effective_from
    };
  }

  const fallback = await getSingleValue(
    'SELECT id, name, rate_per_kg, unit_type FROM food_items WHERE id = $1',
    [foodId]
  );
  if (!fallback) return null;

  return {
    food_price_history_id: null,
    food_name_snapshot: fallback.name,
    unit_type_snapshot: fallback.unit_type || 'kg',
    unit_rate: Number(fallback.rate_per_kg || 0),
    rate_effective_from: null
  };
}

async function getFoodsWithHistory() {
  const result = await pool.query('SELECT * FROM food_items ORDER BY name');
  const foods = result.rows;
  const foodsWithHistory = [];

  for (const food of foods) {
    const priceHistory = await getFoodPriceHistoryRows(food.id);
    foodsWithHistory.push({
      ...food,
      priceHistory
    });
  }

  return foodsWithHistory;
}

function mergeExpenseRows(expenses = []) {
  const merged = new Map();
  const preservedFeedRows = [];

  expenses.forEach((item, index) => {
    const amount = Number(item.amount || 0);
    const hasExplicitAmount = item.amount !== '' && item.amount !== null && item.amount !== undefined;
    if (!hasExplicitAmount) return;

    if ((item.expense_type || 'common') === 'feed') {
      preservedFeedRows.push({
        ...item,
        expense_type: 'feed',
        amount: Number(amount.toFixed(2)),
        quantity_kg: Number(item.quantity_kg || 0),
        unit_rate: Number(item.unit_rate || 0),
        entry_shift: item.entry_shift || '',
        payment_mode: (item.payment_mode || 'Cash').trim() || 'Cash',
        description: (item.description || '').trim()
      });
      return;
    }

    const categoryKey = item.category_id || (item.category_name || '').trim().toLowerCase() || `row-${index}`;
    const paymentMode = (item.payment_mode || 'Cash').trim() || 'Cash';
    const description = (item.description || '').trim();
    const key = `${categoryKey}::${paymentMode.toLowerCase()}`;

    if (!merged.has(key)) {
      merged.set(key, {
        ...item,
        amount: Number(amount.toFixed(2)),
        payment_mode: paymentMode,
        description
      });
      return;
    }

    const current = merged.get(key);
    current.amount = Number((Number(current.amount || 0) + amount).toFixed(2));
    current.description = Array.from(new Set([current.description, description].map((value) => value?.trim()).filter(Boolean))).join(' | ');
    current.bill_path = current.bill_path || item.bill_path || null;
    if (!current.category_name && item.category_name) current.category_name = item.category_name;
  });

  return [...Array.from(merged.values()), ...preservedFeedRows];
}

async function getDailyEntryBundle(entry) {
  if (!entry) return { entry: null, cowEntries: [], milkSales: [], expenses: [] };

  const cowEntriesResult = await pool.query(`
    SELECT me.*, c.name AS cow_name, c.status AS cow_status
    FROM cow_milk_entries me
    LEFT JOIN cows c ON c.id = me.cow_id
    WHERE me.daily_entry_id = $1
    ORDER BY me.id ASC
  `, [entry.id]);

  const milkSalesResult = await pool.query(`
    SELECT ms.*, COALESCE(b.name, 'Unknown buyer') buyer_name
    FROM milk_sales ms
    LEFT JOIN buyers b ON b.id = ms.buyer_id
    WHERE ms.daily_entry_id = $1
    ORDER BY ms.id ASC
  `, [entry.id]);

  const expensesResult = await pool.query(`
    SELECT e.*, COALESCE(c.name, 'Unknown category') category_name, cw.name AS cow_name,
           COALESCE(e.food_name_snapshot, f.name) AS food_name,
           COALESCE(e.unit_type_snapshot, f.unit_type, 'kg') AS unit_type
    FROM expenses e
    LEFT JOIN expense_categories c ON c.id = e.category_id
    LEFT JOIN cows cw ON cw.id = e.cow_id
    LEFT JOIN food_items f ON f.id = e.food_item_id
    WHERE e.daily_entry_id = $1
    ORDER BY e.id ASC
  `, [entry.id]);

  return {
    entry,
    cowEntries: cowEntriesResult.rows,
    milkSales: milkSalesResult.rows,
    expenses: mergeExpenseRows(expensesResult.rows)
  };
}

async function getCalfBundle(calf) {
  if (!calf) return { calf: null, expenses: [] };

  const expensesResult = await pool.query(`
    SELECT ce.*, COALESCE(ce.food_name_snapshot, f.name) AS food_name,
           COALESCE(ce.unit_type_snapshot, f.unit_type, 'kg') AS unit_type, c.name AS category_name
    FROM calf_expenses ce
    LEFT JOIN food_items f ON f.id = ce.food_item_id
    LEFT JOIN expense_categories c ON c.id = ce.category_id
    WHERE ce.calf_id = $1
    ORDER BY ce.expense_date DESC, ce.id DESC
  `, [calf.id]);

  return { calf, expenses: expensesResult.rows };
}

async function getInvestmentIncomeProgress(investmentDate) {
  const progress = await getSingleValue(
    `SELECT COALESCE(SUM(total_income), 0) AS income
     FROM daily_entries
     WHERE entry_date >= $1`,
    [investmentDate]
  );
  return Number(progress?.income || 0);
}

async function findInvestmentCompletion(investmentDate, investmentAmount) {
  const result = await pool.query(
    `SELECT entry_date, total_income
     FROM daily_entries
     WHERE entry_date >= $1
     ORDER BY entry_date ASC, id ASC`,
    [investmentDate]
  );

  let runningIncome = 0;
  for (const row of result.rows) {
    runningIncome += Number(row.total_income || 0);
    if (runningIncome >= Number(investmentAmount || 0)) {
      return {
        completed_on: row.entry_date,
        completed_income_amount: Number(runningIncome.toFixed(2))
      };
    }
  }

  return null;
}

async function refreshInvestmentStatuses() {
  const activeInvestmentsResult = await pool.query(
    'SELECT * FROM investments WHERE status = $1 ORDER BY investment_date ASC, id ASC',
    ['active']
  );

  for (const investment of activeInvestmentsResult.rows) {
    const completion = await findInvestmentCompletion(investment.investment_date, investment.investment_amount);
    if (completion) {
      await pool.query(
        `UPDATE investments
         SET status = $1, completed_on = $2, completed_income_amount = $3, updated_at = NOW()
         WHERE id = $4`,
        ['finished', completion.completed_on, completion.completed_income_amount, investment.id]
      );
    }
  }
}

async function getInvestments() {
  await refreshInvestmentStatuses();

  const result = await pool.query(
    'SELECT * FROM investments ORDER BY status ASC, investment_date DESC, id DESC'
  );

  const investments = [];
  for (const investment of result.rows) {
    const recoveredIncome = investment.status === 'finished'
      ? Number(investment.completed_income_amount || investment.investment_amount || 0)
      : await getInvestmentIncomeProgress(investment.investment_date);
    const investmentAmount = Number(investment.investment_amount || 0);
    const pendingAmount = investment.status === 'finished' ? 0 : Math.max(investmentAmount - recoveredIncome, 0);

    investments.push({
      ...investment,
      investment_amount: investmentAmount,
      completed_income_amount: Number(investment.completed_income_amount || 0),
      recovered_income: Number(recoveredIncome.toFixed(2)),
      pending_amount: Number(pendingAmount.toFixed(2))
    });
  }

  return investments;
}

async function getDashboard() {
  const today = dayjs().format('YYYY-MM-DD');
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
  const monthEnd = dayjs().endOf('month').format('YYYY-MM-DD');

  const todayEntry = await getSingleValue('SELECT * FROM daily_entries WHERE entry_date = $1', [today]) || {};
  const monthly = await getSingleValue(
    `SELECT COALESCE(SUM(total_income),0) income, COALESCE(SUM(total_expenses),0) expenses,
            COALESCE(SUM(profit),0) profit, COALESCE(SUM(total_milk_litres),0) milk
     FROM daily_entries WHERE entry_date BETWEEN $1 AND $2`,
    [monthStart, monthEnd]
  );

  const buyerSplitResult = await pool.query(
    `SELECT b.name, ROUND(SUM(ms.litres)::numeric, 2) value
     FROM milk_sales ms
     LEFT JOIN buyers b ON b.id=ms.buyer_id
     GROUP BY b.name
     ORDER BY value DESC`
  );

  const trendResult = await pool.query(
    `SELECT entry_date as date, total_income as income, total_expenses as expenses,
            profit, total_milk_litres as milk, remaining_milk_litres as remaining
     FROM daily_entries
     ORDER BY entry_date DESC
     LIMIT 30`
  );

  const cowSummaryResult = await pool.query(
    `SELECT c.id, c.name, c.status, ROUND(COALESCE(SUM(me.total_litres),0)::numeric, 2) totalMilk,
            COUNT(CASE WHEN me.total_litres=0 THEN 1 END) nilDays
     FROM cows c
     LEFT JOIN cow_milk_entries me ON me.cow_id=c.id
     LEFT JOIN daily_entries d ON d.id=me.daily_entry_id AND d.entry_date BETWEEN $1 AND $2
     GROUP BY c.id
     ORDER BY totalMilk DESC`,
    [monthStart, monthEnd]
  );

  const cowSummary = cowSummaryResult.rows;

  return {
    today: {
      totalMilkLitres: Number(todayEntry.total_milk_litres || 0),
      totalIncome: Number(todayEntry.total_income || 0),
      totalExpenses: Number(todayEntry.total_expenses || 0),
      profit: Number(todayEntry.profit || 0),
      remainingMilkLitres: Number(todayEntry.remaining_milk_litres || 0)
    },
    monthly: {
      income: Number(monthly.income || 0),
      expenses: Number(monthly.expenses || 0),
      profit: Number(monthly.profit || 0),
      milk: Number(monthly.milk || 0),
      profitMargin: monthly.income ? Number(((monthly.profit / monthly.income) * 100).toFixed(2)) : 0
    },
    charts: { buyerSplit: buyerSplitResult.rows, trend: trendResult.rows.reverse() },
    cows: {
      summary: cowSummary,
      best: cowSummary[0] || null,
      low: cowSummary[cowSummary.length - 1] || null
    },
    lastUpdated: todayEntry.updated_at || null
  };
}

app.get('/api/auth/status', async (req, res) => {
  const user = await getSingleValue('SELECT id, username, created_at FROM users LIMIT 1');
  ok(res, { hasUser: !!user, user });
});

app.post('/api/auth/register', body('username').isLength({ min: 3 }), body('password').isLength({ min: 6 }), validate, async (req, res) => {
  const existing = await getSingleValue('SELECT id FROM users LIMIT 1');
  if (existing) return fail(res, 400, 'Single-user account already exists');
  const { username, password } = req.body;
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
    [username, passwordHash]
  );
  const userId = result.rows[0].id;
  const token = jwt.sign({ id: userId, username }, JWT_SECRET, { expiresIn: '7d' });
  ok(res, { token, user: { id: userId, username } });
});

app.post('/api/auth/login', body('username').notEmpty(), body('password').notEmpty(), validate, async (req, res) => {
  const user = await getSingleValue('SELECT * FROM users WHERE username = $1', [req.body.username]);
  if (!user) return fail(res, 401, 'Invalid credentials');
  const match = await bcrypt.compare(req.body.password, user.password_hash);
  if (!match) return fail(res, 401, 'Invalid credentials');
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  ok(res, { token, user: { id: user.id, username: user.username } });
});

app.get('/api/bootstrap', auth, async (req, res) => {
  const dashboard = await getDashboard();
  const cowsResult = await pool.query('SELECT * FROM cows ORDER BY created_at DESC');
  const calvesResult = await pool.query('SELECT * FROM calves ORDER BY created_at DESC');
  const investments = await getInvestments();
  const buyersResult = await pool.query('SELECT * FROM buyers ORDER BY active DESC, name');
  const categoriesResult = await pool.query('SELECT * FROM expense_categories ORDER BY is_default DESC, name');
  const foods = await getFoodsWithHistory();
  const dailyEntriesResult = await pool.query('SELECT * FROM daily_entries ORDER BY entry_date DESC LIMIT 90');

  ok(res, {
    dashboard,
    cows: cowsResult.rows,
    calves: calvesResult.rows,
    investments,
    buyers: buyersResult.rows,
    categories: categoriesResult.rows,
    foods,
    dailyEntries: dailyEntriesResult.rows
  });
});

app.get('/api/dashboard', auth, async (req, res) => {
  const dashboard = await getDashboard();
  ok(res, { dashboard });
});

app.get('/api/daily-entries', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM daily_entries ORDER BY entry_date DESC LIMIT 90');
  const entries = [];
  for (const entry of result.rows) {
    entries.push(await getDailyEntryBundle(entry));
  }
  ok(res, { entries });
});

app.get('/api/daily-entries/:entryDate', auth, async (req, res) => {
  const entry = await getSingleValue('SELECT * FROM daily_entries WHERE entry_date = $1', [req.params.entryDate]);
  const bundle = await getDailyEntryBundle(entry);
  ok(res, bundle);
});

app.post('/api/cows', auth, body('name').notEmpty(), validate, async (req, res) => {
  const { name, breed, age, status, purchase_date, status_date, purchase_price, notes } = req.body;
  const result = await pool.query(
    'INSERT INTO cows (name, breed, age, status, purchase_date, status_date, purchase_price, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [name, breed || '', age || '', status || 'Lactating', purchase_date || null, status_date || null, purchase_price || null, notes || '']
  );
  const cowId = result.rows[0].id;

  await pool.query(
    'INSERT INTO cow_update_history (cow_id, updated_at, changes, snapshot) VALUES ($1, $2, $3, $4)',
    [
      cowId,
      new Date().toISOString(),
      JSON.stringify([{ field: 'Created', oldValue: '(new record)', newValue: name }]),
      JSON.stringify({
        id: cowId, name, breed: breed || '', age: age || '', status: status || 'Lactating',
        purchase_date, status_date, purchase_price: purchase_price || null, notes: notes || ''
      })
    ]
  );

  ok(res, { id: cowId });
});

app.put('/api/cows/:id', auth, async (req, res) => {
  const { name, breed, age, status, purchase_date, status_date, purchase_price, notes } = req.body;
  const cowId = req.params.id;

  const existing = await getSingleValue('SELECT * FROM cows WHERE id = $1', [cowId]);
  if (!existing) return fail(res, 404, 'Cow not found');

  const changes = [];
  const fields = [
    { key: 'name', label: 'Name' },
    { key: 'breed', label: 'Breed' },
    { key: 'age', label: 'Age' },
    { key: 'status', label: 'Lifecycle status' },
    { key: 'status_date', label: 'Status date' },
    { key: 'notes', label: 'Notes' }
  ];

  fields.forEach(({ key, label }) => {
    const oldVal = existing[key] ?? '';
    const newVal = key === 'status_date' ? (req.body[key] || '') : (req.body[key] ?? '');
    if (String(oldVal) !== String(newVal)) {
      changes.push({ field: label, oldValue: oldVal || '(empty)', newValue: newVal || '(empty)' });
    }
  });

  await pool.query(
    'UPDATE cows SET name=$1, breed=$2, age=$3, status=$4, purchase_date=$5, status_date=$6, purchase_price=$7, notes=$8 WHERE id=$9',
    [name, breed, age, status, purchase_date || null, status_date || null, purchase_price || null, notes, cowId]
  );

  if (changes.length > 0) {
    const updated = await getSingleValue('SELECT * FROM cows WHERE id = $1', [cowId]);
    await pool.query(
      'INSERT INTO cow_update_history (cow_id, updated_at, changes, snapshot) VALUES ($1, $2, $3, $4)',
      [
        cowId,
        new Date().toISOString(),
        JSON.stringify(changes),
        JSON.stringify({
          id: updated.id, name: updated.name, breed: updated.breed, age: updated.age,
          status: updated.status, purchase_date: updated.purchase_date, status_date: updated.status_date,
          purchase_price: updated.purchase_price, notes: updated.notes
        })
      ]
    );
  }

  ok(res, { changes });
});

app.get('/api/cows/:id/history', auth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM cow_update_history WHERE cow_id = $1 ORDER BY updated_at DESC',
    [req.params.id]
  );
  const history = result.rows.map((entry) => ({
    ...entry,
    changes: JSON.parse(entry.changes),
    snapshot: JSON.parse(entry.snapshot)
  }));
  ok(res, { history });
});

app.delete('/api/cows/:id', auth, async (req, res) => {
  const existing = await getSingleValue('SELECT id, name FROM cows WHERE id = $1', [req.params.id]);
  if (!existing) return fail(res, 404, 'Cow not found');
  const used = await getSingleValue('SELECT id FROM cow_milk_entries WHERE cow_id = $1 LIMIT 1', [req.params.id]);
  if (used) return fail(res, 400, 'Cow is already used in saved daily entries. Update its status instead of deleting it.');
  await pool.query('DELETE FROM cows WHERE id = $1', [req.params.id]);
  ok(res, { deletedId: Number(req.params.id), name: existing.name });
});

app.get('/api/calves', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM calves ORDER BY created_at DESC');
  const calves = [];
  for (const calf of result.rows) {
    calves.push(await getCalfBundle(calf));
  }
  ok(res, { calves });
});

app.post('/api/calves', auth, body('name').notEmpty(), validate, async (req, res) => {
  const { name, breed, birth_date, source_type, expected_lactation_date, purchase_price, paid_amount, status, notes } = req.body;
  const result = await pool.query(
    `INSERT INTO calves (name, breed, birth_date, source_type, expected_lactation_date, purchase_price, paid_amount, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [name, breed || '', birth_date || null, source_type || 'raised', expected_lactation_date || null, Number(purchase_price || 0), Number(paid_amount || 0), status || 'Growing', notes || '']
  );
  ok(res, { id: result.rows[0].id });
});

app.put('/api/calves/:id', auth, body('name').notEmpty(), validate, async (req, res) => {
  const { name, breed, birth_date, source_type, expected_lactation_date, purchase_price, paid_amount, status, notes } = req.body;
  await pool.query(
    `UPDATE calves SET name=$1, breed=$2, birth_date=$3, source_type=$4, expected_lactation_date=$5, purchase_price=$6, paid_amount=$7, status=$8, notes=$9 WHERE id=$10`,
    [name, breed || '', birth_date || null, source_type || 'raised', expected_lactation_date || null, Number(purchase_price || 0), Number(paid_amount || 0), status || 'Growing', notes || '', req.params.id]
  );
  ok(res, {});
});

app.delete('/api/calves/:id', auth, async (req, res) => {
  const calf = await getSingleValue('SELECT id, transferred_to_cow_id FROM calves WHERE id=$1', [req.params.id]);
  if (!calf) return fail(res, 404, 'Calf not found');
  if (calf.transferred_to_cow_id) return fail(res, 400, 'Transferred calf records cannot be deleted');
  await pool.query('DELETE FROM calves WHERE id=$1', [req.params.id]);
  ok(res, {});
});

app.post('/api/calves/:id/expenses', auth, async (req, res) => {
  const calf = await getSingleValue('SELECT * FROM calves WHERE id=$1', [req.params.id]);
  if (!calf) return fail(res, 404, 'Calf not found');
  const { expense_date, expense_type, category_id, food_item_id, food_price_history_id, food_name_snapshot, unit_type_snapshot, rate_effective_from, quantity_kg, unit_rate, amount, entry_shift, description, payment_mode } = req.body;
  if (!expense_date) return fail(res, 400, 'Expense date is required');

  const resolvedFoodSnapshot = (expense_type || 'common') === 'feed' && food_item_id
    ? (food_name_snapshot || unit_type_snapshot || food_price_history_id || rate_effective_from ? {
        food_price_history_id: food_price_history_id || null,
        food_name_snapshot: food_name_snapshot || null,
        unit_type_snapshot: unit_type_snapshot || 'kg',
        unit_rate: Number(unit_rate || 0),
        rate_effective_from: rate_effective_from || null
      } : await resolveFoodRateSnapshot(food_item_id, expense_date))
    : null;

  await pool.query(
    `INSERT INTO calf_expenses (calf_id, expense_date, expense_type, category_id, food_item_id, food_price_history_id, food_name_snapshot, unit_type_snapshot, rate_effective_from, quantity_kg, unit_rate, amount, entry_shift, description, payment_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      req.params.id, expense_date, expense_type || 'common', category_id || null, food_item_id || null,
      resolvedFoodSnapshot?.food_price_history_id || null, resolvedFoodSnapshot?.food_name_snapshot || null,
      resolvedFoodSnapshot?.unit_type_snapshot || null, resolvedFoodSnapshot?.rate_effective_from || null,
      Number(quantity_kg || 0), Number((resolvedFoodSnapshot?.unit_rate ?? unit_rate) || 0), Number(amount || 0),
      (expense_type || 'common') === 'feed' ? (entry_shift || 'Morning') : null, description || '', payment_mode || 'Cash'
    ]
  );
  ok(res, {});
});

app.delete('/api/calf-expenses/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM calf_expenses WHERE id=$1', [req.params.id]);
  ok(res, {});
});

app.post('/api/calves/:id/transfer', auth, async (req, res) => {
  const calf = await getSingleValue('SELECT * FROM calves WHERE id=$1', [req.params.id]);
  if (!calf) return fail(res, 404, 'Calf not found');
  if (calf.transferred_to_cow_id) return fail(res, 400, 'Calf is already transferred');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const expenseTotalResult = await client.query(
      'SELECT COALESCE(SUM(amount),0) total FROM calf_expenses WHERE calf_id=$1',
      [req.params.id]
    );
    const expenseTotal = expenseTotalResult.rows[0]?.total || 0;
    const priorExpense = Number(expenseTotal || 0);
    const purchasePaid = Number(calf.paid_amount || 0);

    const cowResult = await client.query(
      `INSERT INTO cows (name, breed, age, status, purchase_date, status_date, purchase_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        calf.name,
        calf.breed || '',
        'From calf rearing',
        'Lactating',
        calf.birth_date || dayjs().format('YYYY-MM-DD'),
        dayjs().format('YYYY-MM-DD'),
        purchasePaid,
        [
          calf.notes,
          `Transferred from calf section. Previous expense only for reference: ${priorExpense.toFixed(2)}. Purchase paid before transfer: ${purchasePaid.toFixed(2)}.`
        ].filter(Boolean).join(' | ')
      ]
    );
    const cowId = cowResult.rows[0].id;

    await client.query(
      'UPDATE calves SET transferred_to_cow_id=$1, transferred_at=$2, status=$3 WHERE id=$4',
      [cowId, dayjs().format('YYYY-MM-DD'), 'Transferred', req.params.id]
    );

    await client.query('COMMIT');
    ok(res, { cowId, previousExpense: Number(priorExpense.toFixed(2)), purchasePaid: Number(purchasePaid.toFixed(2)) });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.get('/api/investments', auth, async (req, res) => {
  const investments = await getInvestments();
  ok(res, { investments });
});

app.post('/api/investments', auth, body('title').notEmpty(), body('investment_date').notEmpty(), validate, async (req, res) => {
  const { source_type, source_id, title, investment_date, investment_amount, notes } = req.body;
  const normalizedSourceType = ['cow', 'calf', 'manual'].includes(source_type) ? source_type : 'manual';
  const amount = Number(investment_amount || 0);
  if (!(amount > 0)) return fail(res, 400, 'Investment amount must be greater than zero');

  if (normalizedSourceType !== 'manual' && source_id) {
    const duplicate = await getSingleValue(
      'SELECT id FROM investments WHERE source_type = $1 AND source_id = $2 LIMIT 1',
      [normalizedSourceType, source_id]
    );
    if (duplicate) return fail(res, 400, 'This cow or calf is already imported into investments');
  }

  const result = await pool.query(
    `INSERT INTO investments (source_type, source_id, title, investment_date, investment_amount, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [normalizedSourceType, source_id || null, title, investment_date, amount, notes || '']
  );

  await refreshInvestmentStatuses();
  ok(res, { id: result.rows[0].id });
});

app.put('/api/investments/:id', auth, body('title').notEmpty(), body('investment_date').notEmpty(), validate, async (req, res) => {
  const existing = await getSingleValue('SELECT * FROM investments WHERE id = $1', [req.params.id]);
  if (!existing) return fail(res, 404, 'Investment not found');

  const { title, investment_date, investment_amount, notes } = req.body;
  const amount = Number(investment_amount || 0);
  if (!(amount > 0)) return fail(res, 400, 'Investment amount must be greater than zero');

  await pool.query(
    `UPDATE investments
     SET title = $1, investment_date = $2, investment_amount = $3, notes = $4, updated_at = NOW()
     WHERE id = $5`,
    [title, investment_date, amount, notes || '', req.params.id]
  );

  await refreshInvestmentStatuses();
  ok(res, {});
});

app.delete('/api/investments/:id', auth, async (req, res) => {
  const existing = await getSingleValue('SELECT id, title FROM investments WHERE id = $1', [req.params.id]);
  if (!existing) return fail(res, 404, 'Investment not found');
  await pool.query('DELETE FROM investments WHERE id = $1', [req.params.id]);
  ok(res, { deletedId: Number(req.params.id), title: existing.title });
});

app.post('/api/buyers', auth, body('name').notEmpty(), validate, async (req, res) => {
  const { name, location, default_rate, contact, notes, active } = req.body;
  const result = await pool.query(
    'INSERT INTO buyers (name, location, default_rate, contact, notes, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [name, location || '', default_rate || 0, contact || '', notes || '', active ? true : false]
  );
  ok(res, { id: result.rows[0].id });
});

app.put('/api/buyers/:id', auth, async (req, res) => {
  const { name, location, default_rate, contact, notes, active } = req.body;
  await pool.query(
    'UPDATE buyers SET name=$1, location=$2, default_rate=$3, contact=$4, notes=$5, active=$6 WHERE id=$7',
    [name, location, default_rate || 0, contact, notes, active ? true : false, req.params.id]
  );
  ok(res, {});
});

app.delete('/api/buyers/:id', auth, async (req, res) => {
  const existing = await getSingleValue('SELECT id, name FROM buyers WHERE id = $1', [req.params.id]);
  if (!existing) return fail(res, 404, 'Buyer not found');
  const used = await getSingleValue('SELECT id FROM milk_sales WHERE buyer_id = $1 LIMIT 1', [req.params.id]);
  if (used) return fail(res, 400, 'Buyer is already used in saved milk sales. Edit or deactivate instead.');
  await pool.query('DELETE FROM buyers WHERE id = $1', [req.params.id]);
  ok(res, { deletedId: Number(req.params.id), name: existing.name });
});

app.post('/api/categories', auth, body('name').notEmpty(), validate, async (req, res) => {
  const result = await pool.query(
    'INSERT INTO expense_categories (name, is_default) VALUES ($1, false) RETURNING id',
    [req.body.name]
  );
  ok(res, { id: result.rows[0].id });
});

app.put('/api/categories/:id', auth, body('name').notEmpty(), validate, async (req, res) => {
  await pool.query('UPDATE expense_categories SET name=$1 WHERE id=$2', [req.body.name, req.params.id]);
  ok(res, {});
});

app.delete('/api/categories/:id', auth, async (req, res) => {
  const used = await getSingleValue('SELECT id FROM expenses WHERE category_id=$1 LIMIT 1', [req.params.id]);
  if (used) return fail(res, 400, 'Category is in use and cannot be deleted');
  await pool.query('DELETE FROM expense_categories WHERE id=$1 AND is_default=false', [req.params.id]);
  ok(res, {});
});

app.post('/api/foods', auth, body('name').notEmpty(), validate, async (req, res) => {
  const purchaseKg = Number(req.body.purchase_kg || 0);
  const purchaseAmount = Number(req.body.purchase_amount || 0);
  const ratePerKg = purchaseKg > 0 ? Number((purchaseAmount / purchaseKg).toFixed(2)) : 0;
  const unitType = req.body.unit_type || 'kg';

  const result = await pool.query(
    'INSERT INTO food_items (name, purchase_kg, purchase_amount, rate_per_kg, unit_type, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [req.body.name, purchaseKg, purchaseAmount, ratePerKg, unitType, req.body.notes || '']
  );
  const foodId = result.rows[0].id;

  await pool.query(
    'INSERT INTO food_price_history (food_item_id, purchase_quantity, purchase_amount, unit_rate, unit_type, effective_from, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [foodId, purchaseKg, purchaseAmount, ratePerKg, unitType, new Date().toISOString(), req.body.notes || '']
  );

  ok(res, { id: foodId, ratePerKg });
});

app.put('/api/foods/:id', auth, body('name').notEmpty(), validate, async (req, res) => {
  const existing = await getSingleValue('SELECT * FROM food_items WHERE id = $1', [req.params.id]);
  if (!existing) return fail(res, 404, 'Food item not found');

  const purchaseKg = Number(req.body.purchase_kg || 0);
  const purchaseAmount = Number(req.body.purchase_amount || 0);
  const ratePerKg = purchaseKg > 0 ? Number((purchaseAmount / purchaseKg).toFixed(2)) : 0;
  const unitType = req.body.unit_type || 'kg';

  await pool.query(
    'UPDATE food_items SET name=$1, purchase_kg=$2, purchase_amount=$3, rate_per_kg=$4, unit_type=$5, notes=$6 WHERE id=$7',
    [req.body.name, purchaseKg, purchaseAmount, ratePerKg, unitType, req.body.notes || '', req.params.id]
  );

  const priceChanged = Number(existing.purchase_kg || 0) !== purchaseKg
    || Number(existing.purchase_amount || 0) !== purchaseAmount
    || Number(existing.rate_per_kg || 0) !== ratePerKg
    || String(existing.unit_type || 'kg') !== String(unitType || 'kg');

  if (priceChanged) {
    await pool.query(
      'INSERT INTO food_price_history (food_item_id, purchase_quantity, purchase_amount, unit_rate, unit_type, effective_from, notes) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [req.params.id, purchaseKg, purchaseAmount, ratePerKg, unitType, new Date().toISOString(), req.body.notes || '']
    );
  }

  ok(res, { ratePerKg });
});

app.delete('/api/food-history/:id', auth, async (req, res) => {
  const history = await getSingleValue('SELECT * FROM food_price_history WHERE id = $1', [req.params.id]);
  if (!history) return fail(res, 404, 'Food history entry not found');
  await pool.query('DELETE FROM food_price_history WHERE id = $1', [req.params.id]);
  ok(res, { deletedId: Number(req.params.id), foodItemId: history.food_item_id });
});

app.delete('/api/foods/:id', auth, async (req, res) => {
  const used = await getSingleValue('SELECT id FROM expenses WHERE food_item_id=$1 LIMIT 1', [req.params.id])
    || await getSingleValue('SELECT id FROM calf_expenses WHERE food_item_id=$1 LIMIT 1', [req.params.id]);
  if (used) return fail(res, 400, 'Food item is already used in saved expenses and cannot be deleted');
  await pool.query('DELETE FROM food_items WHERE id=$1', [req.params.id]);
  ok(res, {});
});

app.delete('/api/daily-entries/:id', auth, async (req, res) => {
  const existing = await getSingleValue('SELECT id, entry_date FROM daily_entries WHERE id = $1', [req.params.id]);
  if (!existing) return fail(res, 404, 'Daily entry not found');
  await pool.query('DELETE FROM daily_entries WHERE id = $1', [req.params.id]);
  await refreshInvestmentStatuses();
  ok(res, { deletedId: Number(req.params.id), entryDate: existing.entry_date });
});

app.post('/api/daily-entries', auth, upload.any(), async (req, res) => {
  const payload = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body;
  const { entry_date, total_milk_litres, notes, cowEntries = [], milkSales = [], expenses = [], remaining_milk_usage } = payload;
  if (!entry_date) return fail(res, 400, 'Entry date is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const mergedExpenses = mergeExpenseRows(expenses);
    const totalIncome = milkSales.reduce((sum, item) => sum + Number(item.litres || 0) * Number(item.rate_per_litre || 0), 0);
    const totalExpenses = mergedExpenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const sold = milkSales.reduce((sum, item) => sum + Number(item.litres || 0), 0);
    const remaining = Number(total_milk_litres || 0) - sold;
    const profit = totalIncome - totalExpenses;

    const existingResult = await client.query('SELECT id FROM daily_entries WHERE entry_date = $1', [entry_date]);
    const existing = existingResult.rows[0];
    let dailyEntryId;

    if (existing) {
      dailyEntryId = existing.id;
      await client.query(
        `UPDATE daily_entries SET total_milk_litres=$1, remaining_milk_litres=$2, total_income=$3, total_expenses=$4, profit=$5, notes=$6, updated_at=NOW() WHERE id=$7`,
        [total_milk_litres || 0, remaining, totalIncome, totalExpenses, profit, [notes, remaining_milk_usage].filter(Boolean).join(' | '), dailyEntryId]
      );
      await client.query('DELETE FROM cow_milk_entries WHERE daily_entry_id=$1', [dailyEntryId]);
      await client.query('DELETE FROM milk_sales WHERE daily_entry_id=$1', [dailyEntryId]);
      await client.query('DELETE FROM expenses WHERE daily_entry_id=$1', [dailyEntryId]);
    } else {
      const insertResult = await client.query(
        `INSERT INTO daily_entries (entry_date, total_milk_litres, remaining_milk_litres, total_income, total_expenses, profit, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [entry_date, total_milk_litres || 0, remaining, totalIncome, totalExpenses, profit, [notes, remaining_milk_usage].filter(Boolean).join(' | ')]
      );
      dailyEntryId = insertResult.rows[0].id;
    }

    for (const item of cowEntries) {
      const totalLitres = Number(item.total_litres || 0);
      const shift = item.entry_shift || '';
      const morningLitres = shift === 'Evening' ? 0 : (totalLitres || Number(item.morning_litres || 0));
      const eveningLitres = shift === 'Evening' ? (totalLitres || Number(item.evening_litres || 0)) : (totalLitres ? 0 : Number(item.evening_litres || 0));

      await client.query(
        'INSERT INTO cow_milk_entries (daily_entry_id, cow_id, morning_litres, evening_litres, total_litres, entry_shift, status, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [dailyEntryId, item.cow_id, morningLitres, eveningLitres, totalLitres || (morningLitres + eveningLitres), shift || null, item.status || 'Recorded', item.notes || '']
      );
    }

    for (const item of milkSales) {
      await client.query(
        'INSERT INTO milk_sales (daily_entry_id, buyer_id, litres, rate_per_litre, income, payment_status, entry_shift, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [dailyEntryId, item.buyer_id || null, item.litres || 0, item.rate_per_litre || 0, Number(item.litres || 0) * Number(item.rate_per_litre || 0), 'Paid', item.entry_shift || 'Morning', item.notes || '']
      );
    }

    for (const item of mergedExpenses) {
      const resolvedFoodSnapshot = (item.expense_type || 'common') === 'feed' && item.food_item_id
        ? (item.food_name_snapshot || item.unit_type_snapshot || item.food_price_history_id || item.rate_effective_from ? {
            food_price_history_id: item.food_price_history_id || null,
            food_name_snapshot: item.food_name_snapshot || null,
            unit_type_snapshot: item.unit_type_snapshot || 'kg',
            unit_rate: Number(item.unit_rate || 0),
            rate_effective_from: item.rate_effective_from || null
          } : await resolveFoodRateSnapshot(item.food_item_id, entry_date))
        : null;

      await client.query(
        'INSERT INTO expenses (daily_entry_id, category_id, expense_type, cow_id, food_item_id, food_price_history_id, food_name_snapshot, unit_type_snapshot, rate_effective_from, quantity_kg, unit_rate, amount, entry_shift, description, payment_mode, bill_path) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
        [
          dailyEntryId,
          item.category_id || null,
          item.expense_type || 'common',
          item.cow_id || null,
          item.food_item_id || null,
          resolvedFoodSnapshot?.food_price_history_id || null,
          resolvedFoodSnapshot?.food_name_snapshot || null,
          resolvedFoodSnapshot?.unit_type_snapshot || null,
          resolvedFoodSnapshot?.rate_effective_from || null,
          Number(item.quantity_kg || 0),
          Number((resolvedFoodSnapshot?.unit_rate ?? item.unit_rate) || 0),
          item.amount || 0,
          item.entry_shift || null,
          item.description || '',
          item.payment_mode || 'Cash',
          item.bill_path || null
        ]
      );
    }

    await client.query('COMMIT');

    // Refresh investment statuses outside of transaction
    await refreshInvestmentStatuses();

    ok(res, { entry: { dailyEntryId, totalIncome, totalExpenses, profit, remaining } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.get('/api/reports', auth, async (req, res) => {
  const { start, end } = req.query;
  const from = start || '0000-01-01';
  const to = end || '9999-12-31';

  const summary = await getSingleValue(
    `SELECT COUNT(*) totalDays, COALESCE(SUM(total_milk_litres),0) milk, COALESCE(SUM(total_income),0) income,
            COALESCE(SUM(total_expenses),0) expenses, COALESCE(SUM(profit),0) profit
     FROM daily_entries WHERE entry_date BETWEEN $1 AND $2`,
    [from, to]
  );

  const rowsResult = await pool.query(
    'SELECT * FROM daily_entries WHERE entry_date BETWEEN $1 AND $2 ORDER BY entry_date ASC',
    [from, to]
  );

  const buyerWiseResult = await pool.query(
    `SELECT COALESCE(b.name,'Unknown') name, ROUND(SUM(ms.litres)::numeric, 2) litres, ROUND(SUM(ms.income)::numeric, 2) income
     FROM milk_sales ms
     LEFT JOIN daily_entries d ON d.id=ms.daily_entry_id
     LEFT JOIN buyers b ON b.id=ms.buyer_id
     WHERE d.entry_date BETWEEN $1 AND $2
     GROUP BY b.name
     ORDER BY litres DESC`,
    [from, to]
  );

  const expenseWiseResult = await pool.query(
    `SELECT CASE WHEN e.expense_type='feed' THEN COALESCE(e.food_name_snapshot, f.name, 'Feed') ELSE COALESCE(c.name,'Unknown') END name,
            ROUND(SUM(e.amount)::numeric, 2) amount
     FROM expenses e
     LEFT JOIN expense_categories c ON c.id=e.category_id
     LEFT JOIN food_items f ON f.id=e.food_item_id
     LEFT JOIN daily_entries d ON d.id=e.daily_entry_id
     WHERE d.entry_date BETWEEN $1 AND $2
     GROUP BY CASE WHEN e.expense_type='feed' THEN COALESCE(e.food_name_snapshot, f.name, 'Feed') ELSE COALESCE(c.name,'Unknown') END
     ORDER BY amount DESC`,
    [from, to]
  );

  const cowWiseResult = await pool.query(
    `SELECT cows.name, ROUND(SUM(cow_milk_entries.total_litres)::numeric, 2) litres
     FROM cow_milk_entries
     JOIN cows ON cows.id=cow_milk_entries.cow_id
     JOIN daily_entries d ON d.id=cow_milk_entries.daily_entry_id
     WHERE d.entry_date BETWEEN $1 AND $2
     GROUP BY cows.name
     ORDER BY litres DESC`,
    [from, to]
  );

  ok(res, {
    summary,
    rows: rowsResult.rows,
    buyerWise: buyerWiseResult.rows,
    expenseWise: expenseWiseResult.rows,
    cowWise: cowWiseResult.rows
  });
});

app.get('/api/export/json', auth, async (req, res) => {
  const usersResult = await pool.query('SELECT id, username, created_at FROM users');
  const cowsResult = await pool.query('SELECT * FROM cows');
  const calvesResult = await pool.query('SELECT * FROM calves');
  const buyersResult = await pool.query('SELECT * FROM buyers');
  const categoriesResult = await pool.query('SELECT * FROM expense_categories');
  const foodsResult = await pool.query('SELECT * FROM food_items');
  const foodHistoryResult = await pool.query('SELECT * FROM food_price_history');
  const investmentsResult = await pool.query('SELECT * FROM investments');
  const dailyEntriesResult = await pool.query('SELECT * FROM daily_entries');
  const calfExpensesResult = await pool.query('SELECT * FROM calf_expenses');
  const cowMilkResult = await pool.query('SELECT * FROM cow_milk_entries');
  const milkSalesResult = await pool.query('SELECT * FROM milk_sales');
  const expensesResult = await pool.query('SELECT * FROM expenses');

  ok(res, {
    users: usersResult.rows,
    cows: cowsResult.rows,
    calves: calvesResult.rows,
    buyers: buyersResult.rows,
    expense_categories: categoriesResult.rows,
    food_items: foodsResult.rows,
    food_price_history: foodHistoryResult.rows,
    investments: investmentsResult.rows,
    daily_entries: dailyEntriesResult.rows,
    calf_expenses: calfExpensesResult.rows,
    cow_milk_entries: cowMilkResult.rows,
    milk_sales: milkSalesResult.rows,
    expenses: expensesResult.rows
  });
});

app.delete('/api/account', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM expenses');
    await client.query('DELETE FROM milk_sales');
    await client.query('DELETE FROM cow_milk_entries');
    await client.query('DELETE FROM daily_entries');
    await client.query('DELETE FROM expense_categories');
    await client.query('DELETE FROM food_price_history');
    await client.query('DELETE FROM food_items');
    await client.query('DELETE FROM investments');
    await client.query('DELETE FROM calf_expenses');
    await client.query('DELETE FROM calves');
    await client.query('DELETE FROM buyers');
    await client.query('DELETE FROM cows');
    await client.query('DELETE FROM users');
    await client.query('COMMIT');
    ok(res, { message: 'Account and all data deleted' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.get('/api/meta', auth, async (req, res) => ok(res, { now: new Date().toISOString() }));

app.use((err, req, res, next) => {
  console.error(err);
  if (req.files) req.files.forEach((file) => fs.existsSync(file.path) && fs.unlinkSync(file.path));
  fail(res, 500, 'Server error');
});

if (hasClientBuild) {
  app.get(/^(?!\/api|\/uploads).*/, (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Dairy Farm API running on http://localhost:${PORT}`);
  console.log(`PostgreSQL: ${process.env.DATABASE_URL || 'Not configured'}`);
  console.log(`Uploads dir: ${uploadsDir}`);
  if (hasClientBuild) {
    console.log(`Serving client build from: ${clientDistPath}`);
  }
});

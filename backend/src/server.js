const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// initialize tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS state (
      id INT PRIMARY KEY,
      capital FLOAT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      action TEXT,
      price FLOAT,
      capital FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const res = await pool.query(`SELECT * FROM state WHERE id=1`);

  if (res.rows.length === 0) {
    await pool.query(`INSERT INTO state (id, capital) VALUES (1, 100)`);
  }
}

app.get('/', async (req, res) => {
  try {
    await initDB();

    const dbState = await pool.query(`SELECT * FROM state WHERE id=1`);
    let capital = dbState.rows[0].capital;

    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

    let tradesExecuted = [];

    for (const c of response.data.slice(0, 10)) {
      const symbol = c.symbol;
      const price = parseFloat(c.lastPrice);
      const change = parseFloat(c.priceChangePercent);

      if (change > 2) {
        capital *= 1.01;

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital)
           VALUES ($1, $2, $3, $4)`,
          [symbol, 'BUY', price, capital]
        );

        tradesExecuted.push(`BUY ${symbol}`);
      }

      if (change < -2) {
        capital *= 0.99;

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital)
           VALUES ($1, $2, $3, $4)`,
          [symbol, 'SELL', price, capital]
        );

        tradesExecuted.push(`SELL ${symbol}`);
      }
    }

    await pool.query(
      `UPDATE state SET capital=$1 WHERE id=1`,
      [capital]
    );

    res.json({
      message: "Trading + History Engine 🚀",
      capital: capital.toFixed(2),
      tradesExecuted
    });

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

// NEW: get trade history
app.get('/history', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM trades ORDER BY created_at DESC LIMIT 20`
  );

  res.json(result.rows);
});

app.listen(3000, () => {
  console.log('Server running');
});

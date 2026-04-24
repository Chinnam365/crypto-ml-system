const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// initialize table
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS state (
      id INT PRIMARY KEY,
      capital FLOAT
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

    let trades = [];

    response.data.slice(0, 10).forEach(c => {
      const change = parseFloat(c.priceChangePercent);

      if (change > 2) {
        capital *= 1.01;
        trades.push(`BUY ${c.symbol}`);
      }

      if (change < -2) {
        capital *= 0.99;
        trades.push(`SELL ${c.symbol}`);
      }
    });

    // save back
    await pool.query(
      `UPDATE state SET capital=$1 WHERE id=1`,
      [capital]
    );

    res.json({
      message: "Persistent Trading Engine 🚀",
      capital: capital.toFixed(2),
      trades
    });

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

app.listen(3000, () => {
  console.log('Server running');
});

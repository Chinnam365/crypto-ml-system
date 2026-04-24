const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MAX_POSITIONS = 5;

// ===== INIT DB =====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      entry_price FLOAT,
      capital FLOAT,
      status TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      action TEXT,
      price FLOAT,
      capital FLOAT,
      pnl FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio (
      id INT PRIMARY KEY,
      capital FLOAT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS weights (
      id INT PRIMARY KEY,
      momentum FLOAT
    )
  `);

  // AUTO FIX
  try { await pool.query(`ALTER TABLE positions ADD COLUMN quantity FLOAT`); } catch {}
  try { await pool.query(`ALTER TABLE trades ADD COLUMN change FLOAT`); } catch {}
  try { await pool.query(`ALTER TABLE trades ADD COLUMN score FLOAT`); } catch {}
  try { await pool.query(`ALTER TABLE trades ADD COLUMN volume FLOAT`); } catch {}

  const p = await pool.query(`SELECT * FROM portfolio WHERE id=1`);
  if (p.rows.length === 0) {
    await pool.query(`INSERT INTO portfolio VALUES (1, 100)`);
  }

  const w = await pool.query(`SELECT * FROM weights WHERE id=1`);
  if (w.rows.length === 0) {
    await pool.query(`INSERT INTO weights VALUES (1, 1.2)`);
  }
}

// ===== RESET =====
app.get('/reset', async (req, res) => {
  await initDB();
  await pool.query(`DELETE FROM positions`);
  await pool.query(`DELETE FROM trades`);
  await pool.query(`UPDATE portfolio SET capital=100 WHERE id=1`);
  res.send("Reset complete");
});

// ===== SCORING =====
function scoreCoin(c, w) {
  if (c.change > 6 || c.change < -3) return -999;
  return (c.change > 0 ? c.change : 0) * w.momentum + Math.log10(c.volume || 1);
}

// ===== LEARNING =====
async function updateWeights() {
  const res = await pool.query(`
    SELECT * FROM trades WHERE pnl IS NOT NULL
    ORDER BY created_at DESC LIMIT 50
  `);

  if (res.rows.length < 10) return;

  let win = 0, loss = 0;
  res.rows.forEach(t => t.pnl > 0 ? win++ : loss++);

  let newWeight = 1.2 + (win - loss) * 0.01;

  await pool.query(
    `UPDATE weights SET momentum=$1 WHERE id=1`,
    [Math.max(0.5, Math.min(newWeight, 3))]
  );
}

// ===== MAIN =====
app.get('/', async (req, res) => {
  try {
    await initDB();

    const weights = (await pool.query(`SELECT * FROM weights WHERE id=1`)).rows[0];
    let portfolio = (await pool.query(`SELECT * FROM portfolio WHERE id=1`)).rows[0];

    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');

    const coins = response.data
      .filter(c =>
        c.symbol.endsWith("USDT") &&
        parseFloat(c.volume) > 1000000 &&
        !c.symbol.includes("UP") &&
        !c.symbol.includes("DOWN")
      )
      .slice(0, 200)
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.volume)
      }));

    const scored = coins.map(c => ({
      ...c,
      score: scoreCoin(c, weights)
    }));

    const sorted = scored.sort((a, b) => b.score - a.score);

    // ===== TOP 5 =====
    const top5 = sorted.slice(0, 5);

    // ===== LOAD POSITIONS =====
    let positions = (await pool.query(
      `SELECT * FROM positions WHERE status='OPEN'`
    )).rows;

    let enriched = positions.map(p => {
      const c = coins.find(x => x.symbol === p.symbol);
      if (!c) return null;

      const value = p.quantity * c.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, currentPrice: c.price, value, pnl };
    }).filter(Boolean);

    // ===== EXIT =====
    for (let pos of enriched) {
      if (pos.pnl >= 0.02 || pos.pnl <= -0.01) {
        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [pos.id]);

        portfolio.capital += pos.value;

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl)
           VALUES ($1,$2,$3,$4,$5)`,
          [pos.symbol, pos.pnl > 0 ? 'SELL (TP)' : 'SELL (SL)', pos.currentPrice, pos.value, pos.pnl]
        );

        await updateWeights();
      }
    }

    // REFRESH
    positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

    enriched = positions.map(p => {
      const c = coins.find(x => x.symbol === p.symbol);
      if (!c) return null;

      const value = p.quantity * c.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl };
    }).filter(Boolean);

    // ===== REBALANCE =====
    for (let coin of top5) {
      if (enriched.length >= MAX_POSITIONS) break;

      const exists = enriched.find(p => p.symbol === coin.symbol);
      if (exists) continue;

      const allocation = portfolio.capital / (MAX_POSITIONS - enriched.length || 1);
      if (allocation <= 0) break;

      const quantity = allocation / coin.price;
      portfolio.capital -= allocation;

      await pool.query(
        `INSERT INTO positions(symbol, entry_price, capital, quantity, status)
         VALUES ($1,$2,$3,$4,'OPEN')`,
        [coin.symbol, coin.price, allocation, quantity]
      );

      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital)
         VALUES ($1,'BUY',$2,$3)`,
        [coin.symbol, coin.price, allocation]
      );

      enriched.push({
        symbol: coin.symbol,
        capital: allocation,
        quantity,
        pnl: 0
      });
    }

    // ===== TOTAL PORTFOLIO VALUE =====
    let totalValue = portfolio.capital;
    enriched.forEach(p => totalValue += p.value || p.capital);

    await pool.query(`UPDATE portfolio SET capital=$1 WHERE id=1`, [portfolio.capital]);

    const trades = (await pool.query(
      `SELECT * FROM trades ORDER BY created_at DESC LIMIT 10`
    )).rows;

    res.send(`
      <html>
      <head><meta http-equiv="refresh" content="5"></head>
      <body style="background:#0f172a;color:white;font-family:Arial;padding:20px">

      <h1>🚀 Integrated ML Portfolio Engine</h1>

      <div>💰 Total Portfolio: €${totalValue.toFixed(2)}</div>
      <div>💵 Cash: €${portfolio.capital.toFixed(2)}</div>
      <div>⚙️ Momentum: ${weights.momentum.toFixed(2)}</div>

      <h3>Top Coins</h3>
      ${top5.map(c => `<div>${c.symbol} (${c.change.toFixed(2)}%)</div>`).join('')}

      <h3>Positions (${enriched.length})</h3>
      ${enriched.map(p => `<div>${p.symbol} | ${(p.pnl*100).toFixed(2)}%</div>`).join('')}

      <h3>Recent Trades</h3>
      ${trades.map(t => `<div>${t.action} ${t.symbol}</div>`).join('')}

      </body>
      </html>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

app.listen(3000);

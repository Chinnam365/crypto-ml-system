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
      quantity FLOAT,
      strategy TEXT,
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
      strategy TEXT,
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
    CREATE TABLE IF NOT EXISTS equity (
      id SERIAL PRIMARY KEY,
      value FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_weights (
      id INT PRIMARY KEY,
      momentum FLOAT,
      volume FLOAT,
      recovery FLOAT
    )
  `);

  // Safe column add
  await pool.query(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS strategy TEXT`);
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy TEXT`);

  await pool.query(`
    INSERT INTO model_weights VALUES (1, 1, 1, 1)
    ON CONFLICT DO NOTHING
  `);

  const p = await pool.query(`SELECT * FROM portfolio WHERE id=1`);
  if (p.rows.length === 0) {
    await pool.query(`INSERT INTO portfolio VALUES (1, 100)`);
  }
}

// ===== RESET =====
app.get('/reset', async (req, res) => {
  await initDB();
  await pool.query(`DELETE FROM positions`);
  await pool.query(`DELETE FROM trades`);
  await pool.query(`DELETE FROM equity`);
  await pool.query(`UPDATE portfolio SET capital=100 WHERE id=1`);
  await pool.query(`UPDATE model_weights SET momentum=1, volume=1, recovery=1 WHERE id=1`);
  res.send("Reset complete");
});

// ===== SCORE =====
function scoreCoin(c, Wm, Wv, Wr) {
  const momentum = c.change;
  const volume = Math.log10(c.volume + 1);
  const recovery = c.change < -10 ? Math.abs(c.change) : 0;

  return (Wm * momentum) + (Wv * volume) + (Wr * recovery);
}

// ===== MAIN =====
app.get('/', async (req, res) => {

  if (global.running) return res.send("Processing...");
  global.running = true;

  try {
    await initDB();

    let portfolio = (await pool.query(`SELECT * FROM portfolio WHERE id=1`)).rows[0];

    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');

    const btc = response.data.find(c => c.symbol === "BTCUSDT");
    const btcChange = parseFloat(btc.priceChangePercent);

    let regime = "NEUTRAL";
    if (btcChange > 1) regime = "STRONG";
    else if (btcChange < -1) regime = "WEAK";

    // ===== LOAD WEIGHTS =====
    const w = (await pool.query(`SELECT * FROM model_weights WHERE id=1`)).rows[0];
    let Wm = w.momentum;
    let Wv = w.volume;
    let Wr = w.recovery;

    // ===== COINS =====
    const coins = response.data
      .filter(c => c.symbol.endsWith("USDT"))
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.quoteVolume)
      }));

    // ===== SCORE =====
    const scored = coins.map(c => ({
      ...c,
      score: scoreCoin(c, Wm, Wv, Wr)
    }));

    const top5 = scored.sort((a, b) => b.score - a.score).slice(0, 5);

    // ===== LOAD POSITIONS =====
    let positions = (await pool.query(`
      SELECT id, symbol, entry_price, capital, quantity,
             COALESCE(strategy,'ml') as strategy,
             status
      FROM positions WHERE status='OPEN'
    `)).rows;

    let enriched = positions.map(p => {
      const coin = coins.find(c => c.symbol === p.symbol);
      if (!coin) return null;

      const value = p.quantity * coin.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl, price: coin.price };
    }).filter(Boolean);

    // ===== SELL NON-TOP =====
    for (let pos of enriched) {
      if (!top5.find(c => c.symbol === pos.symbol)) {

        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [pos.id]);
        portfolio.capital += pos.value;

        // ===== LEARNING =====
        const lr = 0.01;

        Wm += lr * pos.pnl * (pos.price - pos.entry_price);
        Wv += lr * pos.pnl;
        Wr += lr * pos.pnl * (pos.pnl < 0 ? 1 : 0);

        await pool.query(`
          UPDATE model_weights
          SET momentum=$1, volume=$2, recovery=$3
          WHERE id=1
        `, [Wm, Wv, Wr]);

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl, strategy)
           VALUES ($1,'SELL',$2,$3,$4,$5)`,
          [pos.symbol, pos.price, pos.value, pos.pnl, pos.strategy]
        );
      }
    }

    // ===== RELOAD =====
    positions = (await pool.query(`
      SELECT id, symbol, entry_price, capital, quantity,
             COALESCE(strategy,'ml') as strategy,
             status
      FROM positions WHERE status='OPEN'
    `)).rows;

    let allocation = portfolio.capital / MAX_POSITIONS;

    // ===== BUY =====
    for (let coin of top5) {

      if (positions.find(p => p.symbol === coin.symbol)) continue;
      if (portfolio.capital < allocation) continue;

      const qty = allocation / coin.price;
      portfolio.capital -= allocation;

      await pool.query(
        `INSERT INTO positions(symbol, entry_price, capital, quantity, strategy, status)
         VALUES ($1,$2,$3,$4,'ml','OPEN')`,
        [coin.symbol, coin.price, allocation, qty]
      );

      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital, strategy)
         VALUES ($1,'BUY',$2,$3,'ml')`,
        [coin.symbol, coin.price, allocation]
      );
    }

    // ===== FINAL STATE =====
    positions = (await pool.query(`
      SELECT id, symbol, entry_price, capital, quantity,
             COALESCE(strategy,'ml') as strategy,
             status
      FROM positions WHERE status='OPEN'
    `)).rows;

    enriched = positions.map(p => {
      const coin = coins.find(c => c.symbol === p.symbol);
      if (!coin) return null;

      const value = p.quantity * coin.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl };
    }).filter(Boolean);

    let total = portfolio.capital;
    enriched.forEach(p => total += p.value);

    await pool.query(`UPDATE portfolio SET capital=$1 WHERE id=1`, [portfolio.capital]);
    await pool.query(`INSERT INTO equity(value) VALUES ($1)`, [total]);

    const trades = await pool.query(`SELECT * FROM trades ORDER BY created_at DESC LIMIT 10`);
    const equity = await pool.query(`SELECT * FROM equity ORDER BY created_at ASC LIMIT 50`);

    // ===== UI =====
    res.send(`
      <body style="background:#0f172a;color:white;padding:20px;font-family:Arial">

      <h1>🧠 Learning Top-5 Engine</h1>

      <div>💰 Total: €${total.toFixed(2)}</div>
      <div>💵 Cash: €${portfolio.capital.toFixed(2)}</div>
      <div>📊 BTC: ${btcChange.toFixed(2)}% (${regime})</div>

      <h3>Model Weights</h3>
      <div>Momentum: ${Wm.toFixed(3)}</div>
      <div>Volume: ${Wv.toFixed(3)}</div>
      <div>Recovery: ${Wr.toFixed(3)}</div>

      <h3>Top 5 Coins</h3>
      ${top5.map(c => `<div>${c.symbol} (${c.score.toFixed(2)})</div>`).join('')}

      <h3>Positions (${enriched.length})</h3>
      ${enriched.map(p =>
        `<div>${p.symbol} ${(p.pnl*100).toFixed(2)}%</div>`
      ).join('')}

      <h3>Recent Trades</h3>
      ${trades.rows.map(t => `<div>${t.action} ${t.symbol}</div>`).join('')}

      <h3>Equity</h3>
      <canvas id="chart"></canvas>

      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <script>
      new Chart(document.getElementById('chart'), {
        type: 'line',
        data: {
          labels: ${JSON.stringify(equity.rows.map((_, i) => i))},
          datasets: [{
            label: 'Portfolio',
            data: ${JSON.stringify(equity.rows.map(e => e.value))},
            borderColor: 'lime'
          }]
        }
      });
      </script>

      </body>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }

  global.running = false;
});

app.listen(3000);

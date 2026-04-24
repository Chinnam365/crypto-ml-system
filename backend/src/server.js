const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== INIT DB =====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS state (
      id INT PRIMARY KEY,
      capital FLOAT,
      position TEXT,
      coin TEXT,
      entry_price FLOAT
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
      change FLOAT,
      score FLOAT,
      volume FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS weights (
      id INT PRIMARY KEY,
      momentum FLOAT,
      zone FLOAT,
      volume FLOAT
    )
  `);

  // Init state
  const s = await pool.query(`SELECT * FROM state WHERE id=1`);
  if (s.rows.length === 0) {
    await pool.query(`INSERT INTO state VALUES (1, 100, 'NONE', NULL, NULL)`);
  }

  // Init weights
  const w = await pool.query(`SELECT * FROM weights WHERE id=1`);
  if (w.rows.length === 0) {
    await pool.query(`
      INSERT INTO weights VALUES (1, 1.2, 2, 0.3)
    `);
  }
}

// ===== SCORING (DYNAMIC) =====
function scoreCoin(c, weights) {
  const change = c.change;

  if (change > 6 || change < -3) return -999;

  const momentum = change > 0 ? change : 0;

  let zoneBonus = 0;
  if (change >= 1 && change <= 3) zoneBonus = 1;
  else if (change > 3 && change <= 5) zoneBonus = 0.5;

  const volumeScore = Math.log10(c.volume || 1);

  return (
    momentum * weights.momentum +
    zoneBonus * weights.zone +
    volumeScore * weights.volume
  );
}

// ===== LEARNING FUNCTION =====
async function updateWeights() {
  const trades = await pool.query(`
    SELECT * FROM trades
    WHERE pnl IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 50
  `);

  if (trades.rows.length < 10) return; // not enough data

  let winMomentum = 0, lossMomentum = 0;
  let winCount = 0, lossCount = 0;

  trades.rows.forEach(t => {
    if (t.pnl > 0) {
      winMomentum += t.change;
      winCount++;
    } else {
      lossMomentum += t.change;
      lossCount++;
    }
  });

  if (winCount === 0 || lossCount === 0) return;

  const avgWin = winMomentum / winCount;
  const avgLoss = lossMomentum / lossCount;

  let newMomentumWeight = 1.2;

  if (avgWin > avgLoss) {
    newMomentumWeight += 0.1;
  } else {
    newMomentumWeight -= 0.1;
  }

  await pool.query(`
    UPDATE weights SET momentum=$1 WHERE id=1
  `, [Math.max(0.5, Math.min(newMomentumWeight, 3))]);
}

// ===== MAIN =====
app.get('/', async (req, res) => {
  try {
    await initDB();

    const dbState = await pool.query(`SELECT * FROM state WHERE id=1`);
    const weightData = await pool.query(`SELECT * FROM weights WHERE id=1`);

    const weights = weightData.rows[0];

    let capital = dbState.rows[0].capital;
    let position = dbState.rows[0].position || "NONE";
    let currentCoin = dbState.rows[0].coin;
    let entryPrice = dbState.rows[0].entry_price;

    if (position === "HOLDING" && !entryPrice) {
      position = "NONE";
      currentCoin = null;
    }

    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

    const coins = response.data
      .filter(c => {
        const s = c.symbol;
        return (
          s.endsWith("USDT") &&
          parseFloat(c.volume) > 1000000 &&
          parseFloat(c.lastPrice) > 0 &&
          !s.includes("UP") &&
          !s.includes("DOWN") &&
          !s.includes("BULL") &&
          !s.includes("BEAR")
        );
      })
      .slice(0, 100)
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

    const top5 = scored.sort((a, b) => b.score - a.score).slice(0, 5);
    const best = top5[0];

    let action = "HOLD";
    let pnl = 0;

    // ENTRY
    if (position === "NONE") {
      if (best.change >= 1 && best.change <= 5) {
        position = "HOLDING";
        currentCoin = best.symbol;
        entryPrice = best.price;
        action = "BUY";

        await pool.query(`
          INSERT INTO trades(symbol, action, price, capital, change, score, volume)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [best.symbol, action, best.price, capital, best.change, best.score, best.volume]);
      }
    }

    // EXIT
    else if (position === "HOLDING") {
      const current = coins.find(c => c.symbol === currentCoin);

      if (current && entryPrice) {
        pnl = (current.price - entryPrice) / entryPrice;

        if (pnl >= 0.02 || pnl <= -0.01) {
          capital *= (1 + pnl);

          action = pnl > 0 ? "SELL (TP)" : "SELL (SL)";

          await pool.query(`
            INSERT INTO trades(symbol, action, price, capital, pnl)
            VALUES ($1,$2,$3,$4,$5)
          `, [currentCoin, action, current.price, capital, pnl]);

          position = "NONE";
          currentCoin = null;
          entryPrice = null;

          await updateWeights(); // 🔥 LEARNING TRIGGER
        }
      }
    }

    await pool.query(`
      UPDATE state SET capital=$1, position=$2, coin=$3, entry_price=$4 WHERE id=1
    `, [capital, position, currentCoin, entryPrice]);

    res.send(`
      <html><body style="background:#0f172a;color:white;font-family:Arial;padding:20px">
      <h1>🚀 Crypto ML (Learning Engine)</h1>
      <h2>Capital: €${capital.toFixed(2)}</h2>
      <h3>Best: ${best.symbol} (${best.change.toFixed(2)}%)</h3>
      <h3>Weights: M=${weights.momentum.toFixed(2)}</h3>
      <h3>Position: ${position} ${currentCoin || ""}</h3>
      <h3>PnL: ${(pnl*100).toFixed(2)}%</h3>
      </body></html>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

app.listen(3000);

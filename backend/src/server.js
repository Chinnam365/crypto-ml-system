const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   STATE (SAFE - NO DB)
========================= */

let portfolio = { capital: 100, cash: 100 };
let positions = [];
let trades = [];

let weights = {
  short: 1,
  mid: 1,
  long: 1,
  crash: 1
};

let stats = { wins: 0, losses: 0, total: 0 };

/* =========================
   SAFE FUNCTION
========================= */

function safe(n, def = 0) {
  return isFinite(n) ? n : def;
}

/* =========================
   FETCH MULTI-TIMEFRAME DATA
========================= */

async function getKlines(symbol, interval) {
  const res = await axios.get(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=2`
  );

  const prev = parseFloat(res.data[0][4]);
  const curr = parseFloat(res.data[1][4]);

  return safe(((curr - prev) / prev) * 100);
}

async function getMarket() {
  const res = await axios.get(
    "https://api.binance.com/api/v3/ticker/24hr"
  );

  const base = res.data
    .filter(c => c.symbol.endsWith("USDT"))
    .filter(c => parseFloat(c.quoteVolume) > 5000000)
    .slice(0, 30);

  const enriched = [];

  for (let c of base) {
    try {
      const [m5, m15, h1, h4] = await Promise.all([
        getKlines(c.symbol, "5m"),
        getKlines(c.symbol, "15m"),
        getKlines(c.symbol, "1h"),
        getKlines(c.symbol, "4h")
      ]);

      enriched.push({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        m5, m15, h1, h4,
        change24: parseFloat(c.priceChangePercent)
      });

    } catch {
      continue;
    }
  }

  return enriched;
}

/* =========================
   SCORING ENGINE
========================= */

function scoreCoins(coins) {
  return coins.map(c => {
    let strategy = "momentum";

    let score =
      weights.short * safe(c.m5 + c.m15) +
      weights.mid * safe(c.h1) +
      weights.long * safe(c.h4 + c.change24);

    if (c.change24 < -3) {
      score += weights.crash * Math.abs(c.change24);
      strategy = "crash";
    }

    return { ...c, score, strategy };
  });
}

/* =========================
   SELECT TOP 5 (WITH EXPLORATION)
========================= */

function pickTop(coins) {
  coins.sort((a, b) => b.score - a.score);

  const top = coins.slice(0, 5);

  // exploration (20%)
  if (Math.random() < 0.2) {
    const randomCoin = coins[Math.floor(Math.random() * coins.length)];
    top[4] = randomCoin;
  }

  return top;
}

/* =========================
   TRADING
========================= */

function trade(topCoins) {
  if (positions.length > 0) return;

  const allocation = portfolio.cash / 5;

  topCoins.forEach(c => {
    const qty = allocation / c.price;
    if (!isFinite(qty) || qty <= 0) return;

    positions.push({
      symbol: c.symbol,
      entry: c.price,
      quantity: qty,
      capital: allocation,
      strategy: c.strategy,
      time: Date.now()
    });

    portfolio.cash -= allocation;
    trades.push(`BUY ${c.symbol}`);
  });
}

/* =========================
   POSITION UPDATE + LEARNING
========================= */

function updatePositions(coins) {
  const updated = [];

  positions.forEach(p => {
    const coin = coins.find(c => c.symbol === p.symbol);
    if (!coin) return;

    const value = safe(p.quantity) * safe(coin.price);
    const pnl = safe((value - p.capital) / p.capital);
    const age = (Date.now() - p.time) / 60000;

    if (!isFinite(pnl)) return;

    // SELL conditions
    if (pnl > 0.02 || pnl < -0.02 || age > 60) {
      portfolio.cash += value;

      trades.push(`SELL ${p.symbol} (${(pnl * 100).toFixed(2)}%)`);

      stats.total++;
      if (pnl > 0) stats.wins++;
      else stats.losses++;

      // learning
      const delta = pnl > 0 ? 0.05 : -0.05;

      if (p.strategy === "momentum") {
        weights.short += delta;
        weights.mid += delta;
        weights.long += delta;
      } else {
        weights.crash += delta;
      }

    } else {
      updated.push({ ...p, pnl });
    }
  });

  positions = updated;
}

/* =========================
   TOTAL VALUE
========================= */

function getTotal(coins) {
  let total = safe(portfolio.cash);

  positions.forEach(p => {
    const coin = coins.find(c => c.symbol === p.symbol);
    if (!coin) return;

    const value = safe(p.quantity) * safe(coin.price);
    if (isFinite(value)) total += value;
  });

  return total;
}

/* =========================
   DASHBOARD
========================= */

app.get("/", async (req, res) => {
  try {
    const coins = await getMarket();

    const scored = scoreCoins(coins);
    const top = pickTop(scored);

    trade(top);
    updatePositions(coins);

    const total = getTotal(coins);

    res.send(`
    <body style="background:#0b1220;color:white;font-family:sans-serif;padding:20px">

    <h1>🧠 ML Engine v3</h1>

    <p>💰 Total: €${safe(total).toFixed(2)}</p>
    <p>💵 Cash: €${safe(portfolio.cash).toFixed(2)}</p>

    <h3>📊 Performance</h3>
    <p>Trades: ${stats.total}</p>
    <p>Win Rate: ${stats.total ? ((stats.wins / stats.total) * 100).toFixed(2) : 0}%</p>

    <h3>⚙️ Weights</h3>
    <p>Short: ${weights.short.toFixed(2)}</p>
    <p>Mid: ${weights.mid.toFixed(2)}</p>
    <p>Long: ${weights.long.toFixed(2)}</p>
    <p>Crash: ${weights.crash.toFixed(2)}</p>

    <h3>🏆 Top 5</h3>
    ${top.map(c => `<p>${c.symbol} (${c.strategy})</p>`).join("")}

    <h3>📦 Positions (${positions.length})</h3>
    ${positions.map(p =>
      `<p>${p.symbol} (${p.strategy}) | ${(safe(p.pnl) * 100).toFixed(2)}%</p>`
    ).join("")}

    <h3>📜 Trades</h3>
    ${trades.slice(-10).map(t => `<p>${t}</p>`).join("")}

    <br/>
    <a href="/reset" style="color:cyan">Reset</a>

    </body>
    `);

  } catch (e) {
    res.send("Error: " + e.message);
  }
});

/* =========================
   RESET
========================= */

app.get("/reset", (req, res) => {
  portfolio = { capital: 100, cash: 100 };
  positions = [];
  trades = [];
  weights = { short: 1, mid: 1, long: 1, crash: 1 };
  stats = { wins: 0, losses: 0, total: 0 };

  res.send("Reset complete");
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log("Running on port", PORT);
});

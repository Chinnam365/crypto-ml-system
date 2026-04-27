const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Sigmoid function
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

async function trainModel() {
  try {
    console.log("🚀 Training started...");

    // ===== LOAD DATA =====
    const result = await pool.query(`
      SELECT f.*, c.close
      FROM features f
      JOIN candles c
      ON f.symbol = c.symbol AND f.time = c.time
      ORDER BY f.time ASC
    `);

    const rows = result.rows;

    if (!rows || rows.length < 100) {
      console.log("❌ Not enough data to train");
      return;
    }

    // ===== LOAD MODEL =====
    const modelRes = await pool.query(`SELECT * FROM model LIMIT 1`);

    if (!modelRes.rows.length) {
      console.log("❌ Model not found");
      return;
    }

    let { w1, w2, w3, w4, w5, w6 } = modelRes.rows[0];

    let lr = 0.01; // learning rate

    // ===== TRAIN LOOP =====
    for (let i = 10; i < rows.length - 5; i++) {
      const r = rows[i];
      const next = rows[i + 3];

      if (!r || !next) continue;

      // ===== SAFE FEATURE EXTRACTION =====
      const f1 = Number(r.macd_hist ?? 0);
      const f2 = Number(r.momentum ?? 0);
      const f3 = Number(r.momentum_mid ?? 0);
      const f4 = Number(r.volume_spike ?? 0);
      const f5 = Number(r.volatility ?? 0);
      const f6 = Number(r.dist_low ?? 0);

      // Normalize (important)
      const x1 = f1 / 100;
      const x2 = f2;
      const x3 = f3;
      const x4 = f4 / 10;
      const x5 = f5;
      const x6 = f6;

      // ===== PREDICTION =====
      const z =
        w1 * x1 +
        w2 * x2 +
        w3 * x3 +
        w4 * x4 +
        w5 * x5 +
        w6 * x6;

      const pred = sigmoid(z);

      // ===== LABEL (future movement) =====
      const current = Number(r.close);
      const future = Number(next.close);

      if (!current || !future) continue;

      // +0.3% movement = WIN
      const y = future > current * 1.003 ? 1 : 0;

      // ===== ERROR =====
      const error = y - pred;

      // ===== UPDATE WEIGHTS =====
      w1 += lr * error * x1;
      w2 += lr * error * x2;
      w3 += lr * error * x3;
      w4 += lr * error * x4;
      w5 += lr * error * x5;
      w6 += lr * error * x6;
    }

    // ===== SAVE MODEL =====
    await pool.query(
      `UPDATE model
       SET w1=$1, w2=$2, w3=$3, w4=$4, w5=$5, w6=$6
       WHERE id=1`,
      [w1, w2, w3, w4, w5, w6]
    );

    console.log("✅ Training completed");
    console.log("Weights:", w1, w2, w3, w4, w5, w6);

  } catch (err) {
    console.error("❌ TRAINING ERROR:", err.message);
  }
}

module.exports = { trainModel };

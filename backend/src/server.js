const express = require('express');
const axios = require('axios');

const app = express();

let capital = 100;
let lastPrices = {};

// run logic every 10 seconds
setInterval(async () => {
  try {
    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

    response.data.slice(0, 10).forEach(c => {
      const symbol = c.symbol;
      const price = parseFloat(c.lastPrice);
      const change = parseFloat(c.priceChangePercent);

      let signal = "HOLD";

      if (change > 2) signal = "BUY";
      if (change < -2) signal = "SELL";

      if (lastPrices[symbol]) {
        const prev = lastPrices[symbol];
        const realChange = (price - prev) / prev;

        if (signal === "BUY") {
          capital *= (1 + realChange);
        }

        if (signal === "SELL") {
          capital *= (1 - realChange);
        }
      }

      lastPrices[symbol] = price;
    });

  } catch (e) {}
}, 10000);

// endpoint only shows result
app.get('/', (req, res) => {
  res.json({
    message: "Live Paper Trading Running 🚀",
    capital: capital.toFixed(2)
  });
});

app.listen(3000, () => {
  console.log('Server running');
});

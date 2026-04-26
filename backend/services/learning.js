function updateWeights(weights, pnl, strategy) {

  const lr = 0.01;

  if (strategy === "momentum") {
    weights.momentum += lr * pnl;
  } else {
    weights.crash += lr * pnl;
  }

  // clamp (important for stability)
  weights.momentum = Math.max(-5, Math.min(5, weights.momentum));
  weights.crash = Math.max(-5, Math.min(5, weights.crash));

  return weights;
}

module.exports = { updateWeights };

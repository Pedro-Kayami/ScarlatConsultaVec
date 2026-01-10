function createLogger(enabled) {
  return (...args) => {
    if (!enabled) {
      return;
    }
    console.log("[debug]", ...args);
  };
}

module.exports = {
  createLogger,
};

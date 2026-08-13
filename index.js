// Entry shim: the real entry point is src/index.ts, compiled to dist/index.js.
// Kept at the repo root so `node index.js` (npm start, Task Scheduler launchers)
// keeps working unchanged.
require("./dist/index.js").main();

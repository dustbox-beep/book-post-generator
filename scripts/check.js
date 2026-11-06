// 動作確認スクリプト: 構文チェック → ローカル配信 → スマホ幅で開いてスクリーンショットとエラーを確認
// 使い方: node scripts/check.js [保存先.png]
const { execFileSync, spawn } = require("child_process");
const path = require("path");
const { chromium, devices } = require("playwright");

const root = path.join(__dirname, "..");
const out = process.argv[2] || path.join(root, "screenshot.png");
const port = 8765;

for (const f of ["script.js", "xlsx-writer.js"]) {
  execFileSync("node", ["--check", path.join(root, f)], { stdio: "inherit" });
}
console.log("構文チェック: OK");

const server = spawn("python3", ["-m", "http.server", String(port)], { cwd: root, stdio: "ignore" });

(async () => {
  let failed = false;
  try {
    await new Promise((r) => setTimeout(r, 800));
    const browser = await chromium.launch();
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://localhost:${port}/index.html`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const version = await page.textContent("#app-version").catch(() => null);
    await page.screenshot({ path: out, fullPage: true });
    await browser.close();

    console.log("表示中の版番号:", version);
    console.log("スクリーンショット:", out);
    // 外部API(openBD等)に届かない環境で出るネットワークエラーは区別して表示する
    const network = errors.filter((e) => /Failed to load resource|net::|fetch/i.test(e));
    const other = errors.filter((e) => !network.includes(e));
    if (network.length) console.log("ネットワーク関連のエラー(環境依存の可能性):\n  " + network.join("\n  "));
    if (other.length) { console.log("エラー:\n  " + other.join("\n  ")); failed = true; }
    else console.log("ページのエラー: なし");
  } catch (e) {
    console.error(e); failed = true;
  } finally {
    server.kill();
    process.exit(failed ? 1 : 0);
  }
})();

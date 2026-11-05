(() => {
  "use strict";

  const CATALOG_KEY = "book-catalog";
  const SAME_ISBN_COOLDOWN_MS = 4000;
  const STATUSES = ["未読", "読書中", "読了"];
  // 持ち主。「両方」は2人とも持っている本（目録は1つのISBNにつき1冊のため）
  const OWNERS = ["自分", "息子"];
  const BOTH = "両方";
  const DEFAULT_OWNER = OWNERS[0];
  // 登録中の持ち主は保存しない（アプリを開き直すと「自分」に戻る）
  const OWNER_RESET_AFTER_MS = 10 * 60 * 1000; // 10分以上ほかのアプリにいたら「自分」に戻す
  let currentOwner = DEFAULT_OWNER;

  const $ = (id) => document.getElementById(id);

  const readerEl = $("reader");
  const startBtn = $("start-scan-btn");
  const stopBtn = $("stop-scan-btn");
  const scanStatus = $("scan-status");
  const manualForm = $("manual-form");
  const manualInput = $("manual-isbn");
  const errorSection = $("error-section");
  const errorMessageEl = $("error-message");
  const catalogList = $("catalog-list");
  const catalogEmpty = $("catalog-empty");
  const catalogCount = $("catalog-count");
  const catalogSearch = $("catalog-search");
  const catalogStatusFilter = $("catalog-status-filter");
  const backupStatus = $("backup-status");
  const editDialog = $("edit-dialog");
  const editForm = $("edit-form");
  const toastEl = $("toast");

  let isScanning = false;
  let lastScan = { isbn: "", time: 0 };
  let lookupBusy = false;
  let editingIsbn = null;
  let ownedView = "owned"; // 目録で表示中：持っている本 / 手放した本
  let ownerView = ""; // 目録で表示中の持ち主（空なら全員）

  // ---------- 共通ユーティリティ ----------

  function showError(message) {
    errorMessageEl.textContent = message;
    errorSection.hidden = false;
  }

  function clearError() {
    errorSection.hidden = true;
    errorMessageEl.textContent = "";
  }

  let toastTimer = null;
  function toast(message, kind) {
    toastEl.textContent = message;
    toastEl.className = "toast" + (kind ? " toast-" + kind : "");
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2500);
  }

  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ISBN-10 → ISBN-13 に変換して表記をそろえる（重複判定のため）
  function normalizeIsbn(raw) {
    const s = String(raw).replace(/[^0-9Xx]/g, "").toUpperCase();
    if (s.length === 13 && /^\d{13}$/.test(s)) return s;
    if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) {
      const body = "978" + s.slice(0, 9);
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
      return body + ((10 - (sum % 10)) % 10);
    }
    return null;
  }

  // 本のISBNは978/979で始まる（日本の本の2段目のバーコード「192…」は価格コードなので除外）
  function isBookIsbn(isbn) {
    return /^97[89]\d{10}$/.test(isbn);
  }

  function scanHint() {
    return "続けてバーコードを読み取れます（1冊ずつ枠内に）";
  }

  // ---------- スキャン ----------
  // カメラ映像を縮小せずに枠の範囲だけ切り出して読み取る（細いバーコードの線をつぶさないため）

  const GUIDE = { w: 0.9, h: 0.38 }; // 枠の大きさ（映像に対する割合）
  const SCAN_INTERVAL_MS = 120;
  const MAX_DECODE_WIDTH = 1280;

  let stream = null;
  let videoEl = null;
  let scanTimer = null;
  let decoding = false;
  let nativeDetector = null;
  let zoomState = null;
  const workCanvas = document.createElement("canvas");
  const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });

  function hasDecoder() {
    return typeof ZXing !== "undefined";
  }

  let zxReader = null;
  function getZxReader() {
    if (!zxReader) {
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      zxReader = new ZXing.MultiFormatReader();
      zxReader.setHints(hints);
    }
    return zxReader;
  }

  function zxDecode(canvas) {
    try {
      const source = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
      return getZxReader().decodeWithState(bitmap).getText();
    } catch {
      return null;
    } finally {
      if (zxReader) zxReader.reset();
    }
  }

  async function setupNativeDetector() {
    // Android の Chrome などにある端末内蔵の読み取り機能（iPhone の Safari には無いので ZXing を使う）
    try {
      if ("BarcodeDetector" in window) {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes("ean_13")) {
          nativeDetector = new BarcodeDetector({ formats: ["ean_13"] });
        }
      }
    } catch {
      nativeDetector = null;
    }
  }

  // 画像（canvas）の中から本の ISBN を探す。下段の価格コードしか見つからなければ "price" を返す
  async function findIsbnInCanvas(canvas) {
    const texts = [];
    if (nativeDetector) {
      try {
        const found = await nativeDetector.detect(canvas);
        found.forEach((f) => texts.push(f.rawValue));
      } catch {}
    }
    if (!texts.some(isBookCode)) {
      const t = zxDecode(canvas);
      if (t) texts.push(t);
    }
    // 上下2段とも写っていて価格コードを先に拾った場合は、上半分・下半分を分けて読み直す
    if (texts.length && !texts.some(isBookCode)) {
      for (const half of splitCanvas(canvas)) {
        const t = zxDecode(half);
        if (t) texts.push(t);
      }
    }
    const book = texts.find(isBookCode);
    if (book) return normalizeIsbn(book);
    return texts.length ? "price" : null;
  }

  function isBookCode(text) {
    const isbn = normalizeIsbn(text);
    return !!isbn && isBookIsbn(isbn);
  }

  function splitCanvas(canvas) {
    const h = Math.floor(canvas.height / 2);
    return [0, h].map((y) => {
      const c = document.createElement("canvas");
      c.width = canvas.width;
      c.height = h;
      c.getContext("2d").drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      return c;
    });
  }

  async function startScan() {
    clearError();
    if (!hasDecoder()) {
      showError("バーコード読み取りライブラリの読み込みに失敗しました。通信環境を確認してページを再読み込みしてください。");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError("このブラウザではカメラを使えません。Safari または Chrome で開いてください。");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
    } catch (err) {
      console.error(err);
      showError("カメラを起動できませんでした。カメラの利用を許可しているかご確認ください。");
      return;
    }

    await setupNativeDetector();

    readerEl.innerHTML = "";
    videoEl = document.createElement("video");
    videoEl.setAttribute("playsinline", "");
    videoEl.muted = true;
    videoEl.srcObject = stream;
    const guide = document.createElement("div");
    guide.className = "scan-guide";
    guide.style.width = GUIDE.w * 100 + "%";
    guide.style.height = GUIDE.h * 100 + "%";
    const line = document.createElement("div");
    line.className = "scan-line";
    guide.appendChild(line);
    readerEl.append(videoEl, guide);
    readerEl.classList.add("is-active");

    try {
      await videoEl.play();
    } catch (err) {
      console.error(err);
    }

    await setupCameraTuning();

    isScanning = true;
    startBtn.hidden = true;
    stopBtn.hidden = false;
    scanStatus.textContent = scanHint();
    scanTimer = setInterval(scanFrame, SCAN_INTERVAL_MS);
  }

  // ピントを合わせ続ける設定と、対応端末ではズーム切替ボタンを用意する
  async function setupCameraTuning() {
    zoomState = null;
    const track = stream && stream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    const caps = track.getCapabilities();
    try {
      if (caps.focusMode && caps.focusMode.includes("continuous")) {
        await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      }
    } catch {}
    if (caps.zoom && caps.zoom.max >= 1.5) {
      const levels = [caps.zoom.min || 1, Math.min(2, caps.zoom.max)];
      zoomState = { track, levels, index: 0 };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "zoom-btn";
      btn.textContent = "ズーム " + levels[1] + "倍";
      btn.addEventListener("click", async () => {
        zoomState.index = 1 - zoomState.index;
        try {
          await track.applyConstraints({ advanced: [{ zoom: levels[zoomState.index] }] });
          btn.textContent = zoomState.index ? "ズーム 1倍" : "ズーム " + levels[1] + "倍";
        } catch {}
      });
      readerEl.appendChild(btn);
    }
  }

  async function scanFrame() {
    if (decoding || !videoEl || videoEl.readyState < 2) return;
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return;
    decoding = true;
    try {
      const sw = Math.floor(vw * GUIDE.w);
      const sh = Math.floor(vh * GUIDE.h);
      const sx = Math.floor((vw - sw) / 2);
      const sy = Math.floor((vh - sh) / 2);
      const scale = Math.min(1, MAX_DECODE_WIDTH / sw);
      workCanvas.width = Math.round(sw * scale);
      workCanvas.height = Math.round(sh * scale);
      workCtx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, workCanvas.width, workCanvas.height);
      const result = await findIsbnInCanvas(workCanvas);
      if (!isScanning) return;
      if (result === "price") {
        scanStatus.textContent = "下段のバーコードを読みました。上段（978…）のバーコードを写してください";
      } else if (result) {
        onScanSuccess(result);
      }
    } finally {
      decoding = false;
    }
  }

  async function stopScan(statusMessage) {
    clearInterval(scanTimer);
    scanTimer = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl = null;
    }
    readerEl.innerHTML = "";
    readerEl.classList.remove("is-active");
    isScanning = false;
    startBtn.hidden = false;
    stopBtn.hidden = true;
    scanStatus.textContent = statusMessage || "";
  }

  function onScanSuccess(isbn) {
    const now = Date.now();
    if (lookupBusy) return;
    if (isbn === lastScan.isbn && now - lastScan.time < SAME_ISBN_COOLDOWN_MS) return;
    lastScan = { isbn, time: now };
    addIsbnToCatalog(isbn);
  }

  startBtn.addEventListener("click", startScan);
  stopBtn.addEventListener("click", () => stopScan(""));
  // 画面を離れたらカメラを止める（電池の消耗と、iPhone で映像が固まるのを防ぐ）
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isScanning) stopScan("");
  });

  // ---------- 登録する本の持ち主 ----------

  function renderOwnerPicker() {
    const cur = getCurrentOwner();
    document.querySelectorAll(".reg-owner").forEach((b) => b.classList.toggle("is-active", b.dataset.owner === cur));
    const notDefault = cur !== DEFAULT_OWNER;
    $("scan-section").classList.toggle("registering-other", notDefault);
    $("reg-owner-note").textContent = notDefault ? "いまは「" + cur + "」の本として登録します" : "";
  }

  document.querySelectorAll(".reg-owner").forEach((b) =>
    b.addEventListener("click", () => {
      currentOwner = OWNERS.includes(b.dataset.owner) ? b.dataset.owner : DEFAULT_OWNER;
      renderOwnerPicker();
    })
  );

  // iPhone ではアプリを閉じずに裏に回すだけのことも多いので、
  // しばらく離れていたら「自分」に戻す
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && Date.now() - hiddenAt >= OWNER_RESET_AFTER_MS && currentOwner !== DEFAULT_OWNER) {
      currentOwner = DEFAULT_OWNER;
      renderOwnerPicker();
      toast("登録する本の持ち主を「" + DEFAULT_OWNER + "」に戻しました");
    }
  });

  // 以前の版で保存していた「登録中の持ち主」を消す
  try {
    localStorage.removeItem("current-owner");
  } catch {}

  // ---------- 写真から読み取る ----------

  const photoInput = $("photo-input");
  photoInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    clearError();
    if (!hasDecoder()) {
      showError("バーコード読み取りライブラリの読み込みに失敗しました。通信環境を確認してページを再読み込みしてください。");
      return;
    }
    if (isScanning) await stopScan("");
    scanStatus.textContent = "写真からバーコードを探しています...";
    await setupNativeDetector();
    let isbn = null;
    try {
      isbn = await decodePhoto(file);
    } catch (err) {
      console.error(err);
    }
    if (!isbn) {
      scanStatus.textContent = "";
      showError("写真からISBNバーコードを見つけられませんでした。バーコードが大きく写るように、ピントを合わせて撮り直してください。");
      return;
    }
    scanStatus.textContent = "読み取りました: " + isbn;
    addIsbnToCatalog(isbn);
  });

  // 写真を複数の大きさ・切り出し方で試し、978/979で始まるコードを探す
  async function decodePhoto(file) {
    const img = await loadImage(file);
    try {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const crops = [
        [0, 0, W, H],
        [0, 0, W, H / 2],
        [0, H / 4, W, H / 2],
        [0, H / 2, W, H / 2],
      ];
      for (const maxSide of [1600, 1000, 2400]) {
        for (const [sx, sy, sw, sh] of crops) {
          const canvas = cropToCanvas(img, sx, sy, sw, sh, maxSide);
          const result = await findIsbnInCanvas(canvas);
          if (result && result !== "price") return result;
          // 重い処理が続くので、画面が固まらないよう少し休む
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      return null;
    } finally {
      URL.revokeObjectURL(img.src);
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  function cropToCanvas(img, sx, sy, sw, sh, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  manualForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const isbn = normalizeIsbn(manualInput.value);
    if (!isbn) {
      showError("正しいISBN（10桁または13桁）を入力してください。");
      return;
    }
    manualInput.value = "";
    addIsbnToCatalog(isbn);
  });

  // ---------- 書誌情報の取得 ----------
  // openBD（版元ドットコムのデータ）を基本にして、足りない項目を国立国会図書館 → Google Books の順で補う

  const FIELDS = ["title", "author", "publisher", "pubdate", "price", "pages", "form", "genre", "series", "cover"];

  // Cコード（書店の分類番号）の2桁目＝発行形態、3〜4桁目＝内容
  const CCODE_FORM = { 0: "単行本", 1: "文庫", 2: "新書", 3: "全集・双書", 4: "ムック", 5: "辞典・事典", 6: "図鑑", 7: "絵本", 9: "コミック" };
  const CCODE_GENRE = {
    "00": "総記", "01": "百科事典", "02": "年鑑・雑誌", "04": "情報科学",
    "10": "哲学", "11": "心理学", "12": "倫理学", "14": "宗教", "15": "仏教", "16": "キリスト教",
    "20": "歴史総記", "21": "日本歴史", "22": "外国歴史", "23": "伝記", "25": "地理", "26": "旅行",
    "30": "社会科学総記", "31": "政治", "32": "法律", "33": "経済・財政・統計", "34": "経営", "36": "社会", "37": "教育", "39": "民族・風習",
    "40": "自然科学総記", "41": "数学", "42": "物理学", "43": "化学", "44": "天文・地学", "45": "生物学", "47": "医学・歯学・薬学",
    "50": "工学総記", "51": "土木", "52": "建築", "53": "機械", "54": "電気", "55": "電子・通信", "56": "海事", "57": "採鉱・冶金", "58": "その他の工業",
    "60": "産業総記", "61": "農林業", "62": "水産業", "63": "商業", "65": "交通・通信",
    "70": "芸術総記", "71": "絵画・彫刻", "72": "写真・工芸", "73": "音楽・舞踊", "74": "演劇・映画", "75": "体育・スポーツ", "76": "諸芸・娯楽", "77": "家事", "79": "コミックス・劇画",
    "80": "語学総記", "81": "日本語", "82": "英米語", "84": "ドイツ語", "85": "フランス語", "87": "各国語",
    "90": "文学総記", "91": "日本文学総記", "92": "日本文学（詩歌）", "93": "日本文学（小説）", "95": "日本文学（評論・随筆）", "97": "外国文学（小説）", "98": "外国文学（その他）",
  };

  async function fetchBook(isbn) {
    const tasks = [fetchOpenBD(isbn), fetchGoogleBooks(isbn), fetchNDL(isbn)];
    const results = await Promise.allSettled(tasks);
    const found = results.filter((r) => r.status === "fulfilled" && r.value).map((r) => r.value);
    if (!found.length) {
      // すべて通信エラーなら呼び出し元にエラーとして伝える
      if (results.every((r) => r.status === "rejected")) throw new Error("all sources failed");
      return null;
    }
    // 優先順：openBD → 国立国会図書館 → Google
    const order = { openbd: 0, ndl: 1, google: 2 };
    found.sort((a, b) => order[a.source] - order[b.source]);
    const book = { isbn };
    // 項目ごとに、実際に使った情報源を記録する
    const fieldSources = {};
    FIELDS.forEach((k) => {
      const hit = found.find((f) => f[k]);
      book[k] = hit ? hit[k] : "";
      if (hit) fieldSources[k] = hit.source;
    });
    // 表紙：openBD に無ければ国立国会図書館の書影、それも無ければ Google
    // （Google の画像は日本の本だと「画像なし」の絵のことが多いので最後にする）
    const primaryCover = found.find((f) => f.source === "openbd" && f.cover);
    if (primaryCover) {
      book.cover = primaryCover.cover;
      fieldSources.cover = "openbd";
    } else if (await imageExists(ndlThumbnailUrl(isbn))) {
      book.cover = ndlThumbnailUrl(isbn);
      fieldSources.cover = "ndl";
    } else {
      const g = found.find((f) => f.source === "google" && f.cover);
      book.cover = g ? g.cover : "";
      if (g) fieldSources.cover = "google";
      else delete fieldSources.cover;
    }
    // 著者：日本語（かな・漢字）の表記を最優先する。
    // 同じ条件なら、openBD の図書館式（例：筒井,康隆,1934-）より他の情報源の表記を優先
    const authorScore = (f) => (hasJapanese(f.author) ? 2 : 0) + (f.rawAuthorLibraryStyle ? 0 : 1);
    let bestAuthor = null;
    found.forEach((f) => {
      if (f.author && (!bestAuthor || authorScore(f) > authorScore(bestAuthor))) bestAuthor = f;
    });
    if (bestAuthor) {
      book.author = bestAuthor.author;
      fieldSources.author = bestAuthor.source;
    }
    if (!book.title) book.title = "(タイトル不明)";
    book.fieldSources = fieldSources;
    book.sources = sourcesUsed(fieldSources);
    return book;
  }

  // かな・漢字を含むか（日本語の表記かどうか）
  function hasJapanese(text) {
    return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(text || "");
  }

  // 実際に使った情報源を、優先順に並べて返す
  function sourcesUsed(fieldSources) {
    const used = new Set(Object.values(fieldSources));
    return ["openbd", "ndl", "google"].filter((x) => used.has(x));
  }

  // 画像が実際に読み込めるか確かめる（存在しない書影を表紙にしないため）
  function imageExists(url, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => done(false), timeoutMs);
      function done(ok) {
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(ok);
      }
      img.onload = () => done(img.naturalWidth > 1 && img.naturalHeight > 1);
      img.onerror = () => done(false);
      img.src = url;
    });
  }

  // ---- openBD ----
  async function fetchOpenBD(isbn) {
    const res = await fetch("https://api.openbd.jp/v1/get?isbn=" + encodeURIComponent(isbn));
    if (!res.ok) throw new Error("openBD HTTP " + res.status);
    const data = await res.json();
    const entry = data && data[0];
    return entry ? extractOpenBD(entry, isbn) : null;
  }

  function extractOpenBD(entry, isbn) {
    const summary = entry.summary || {};
    const onix = entry.onix || {};
    const detail = onix.DescriptiveDetail || {};

    let pages = "";
    if (Array.isArray(detail.Extent)) {
      const ext = detail.Extent.find((e) => e.ExtentType === "11") || detail.Extent[0];
      if (ext && ext.ExtentValue) pages = String(Number(ext.ExtentValue) || "");
    }

    let price = "";
    const supply = onix.ProductSupply && onix.ProductSupply.SupplyDetail;
    if (supply && Array.isArray(supply.Price) && supply.Price[0] && supply.Price[0].PriceAmount) {
      price = String(supply.Price[0].PriceAmount);
    }

    let form = "";
    let genre = "";
    if (Array.isArray(detail.Subject)) {
      const c = detail.Subject.find((s) => s.SubjectSchemeIdentifier === "78");
      const code = c && String(c.SubjectCode || "").replace(/^C/i, "");
      if (code && /^\d{4}$/.test(code)) {
        form = CCODE_FORM[code[1]] || "";
        genre = CCODE_GENRE[code.slice(2)] || "";
      }
    }

    const title = [summary.title, summary.volume].filter(Boolean).join(" ");
    return {
      source: "openbd",
      isbn,
      title,
      author: cleanAuthor(summary.author || ""),
      rawAuthorLibraryStyle: /,/.test(summary.author || ""),
      publisher: summary.publisher || "",
      pubdate: normalizeDate(summary.pubdate || ""),
      price,
      pages,
      form,
      genre,
      series: summary.series || "",
      cover: summary.cover || "",
    };
  }

  // ---- Google Books ----
  async function fetchGoogleBooks(isbn) {
    const res = await fetch("https://www.googleapis.com/books/v1/volumes?q=isbn:" + encodeURIComponent(isbn));
    if (!res.ok) throw new Error("Google HTTP " + res.status);
    const data = await res.json();
    const items = (data && data.items) || [];
    // 念のため ISBN が一致するものだけを使う
    const item = items.find((it) =>
      ((it.volumeInfo && it.volumeInfo.industryIdentifiers) || []).some(
        (id) => normalizeIsbn(id.identifier) === isbn
      )
    );
    if (!item) return null;
    const v = item.volumeInfo;
    const img = v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail);
    return {
      source: "google",
      isbn,
      title: [v.title, v.subtitle].filter(Boolean).join(" "),
      author: (v.authors || []).join("、"),
      publisher: v.publisher || "",
      pubdate: normalizeDate(v.publishedDate || ""),
      price: "",
      pages: v.pageCount ? String(v.pageCount) : "",
      form: "",
      genre: "",
      series: "",
      cover: img ? img.replace(/^http:/, "https:").replace(/&edge=curl/, "") : "",
    };
  }

  // ---- 国立国会図書館サーチ ----
  const NDL_OPENSEARCH = "https://ndlsearch.ndl.go.jp/api/opensearch";
  // NDC（日本十進分類法）の大まかな区分
  const NDC_GENRE = { 0: "総記", 1: "哲学・宗教", 2: "歴史・地理", 3: "社会科学", 4: "自然科学", 5: "技術・工学", 6: "産業", 7: "芸術・スポーツ", 8: "言語", 9: "文学" };
  const NDC_DETAIL = { 913: "日本文学（小説）", 914: "日本文学（評論・随筆）", 911: "日本文学（詩歌）", 933: "外国文学（小説）", 923: "外国文学（小説）", 953: "外国文学（小説）", 726: "コミックス・劇画" };

  function ndlThumbnailUrl(isbn) {
    return "https://ndlsearch.ndl.go.jp/thumbnail/" + isbn + ".jpg";
  }

  async function fetchNDL(isbn) {
    const res = await fetch(NDL_OPENSEARCH + "?cnt=5&isbn=" + encodeURIComponent(isbn));
    if (!res.ok) throw new Error("NDL HTTP " + res.status);
    const xml = new DOMParser().parseFromString(await res.text(), "application/xml");
    const items = [...xml.getElementsByTagName("item")];
    if (!items.length) return null;
    const pick = (el, name) => {
      const n = [...el.getElementsByTagName("*")].find((x) => x.localName === name || x.nodeName === name);
      return n ? n.textContent.trim() : "";
    };
    const pickAll = (el, name) =>
      [...el.getElementsByTagName("*")].filter((x) => x.localName === name).map((x) => x.textContent.trim());
    // ISBN が一致し、なるべく「図書」の項目を選ぶ
    const item =
      items.find((it) => pickAll(it, "identifier").some((v) => normalizeIsbn(v) === isbn)) || items[0];

    const extent = pick(item, "extent"); // 例：「478p ; 16cm」
    const pagesMatch = extent.match(/(\d+)\s*p/);
    const ndc = pickAll(item, "subject").find((v) => /^\d{3}(\.\d+)?$/.test(v)) || "";
    let genre = "";
    if (ndc) genre = NDC_DETAIL[ndc.slice(0, 3)] || NDC_GENRE[ndc[0]] || "";
    const creators = pickAll(item, "creator");
    const author = (creators.length ? creators : [pick(item, "author")])
      .map((a) =>
        a
          .replace(/\s*(著|作|著者)$/, "")
          .replace(/\s+(訳|編|編著|監修|絵|画|写真|監訳|共訳)$/, "（$1）")
          .trim()
      )
      .filter(Boolean)
      .join("、");

    return {
      source: "ndl",
      isbn,
      title: pick(item, "title"),
      author: cleanAuthor(author),
      publisher: pick(item, "publisher"),
      pubdate: normalizeDate(pick(item, "issued") || pick(item, "date")),
      price: (pick(item, "price").match(/\d[\d,]*/) || [""])[0].replace(/,/g, ""),
      pages: pagesMatch ? pagesMatch[1] : "",
      form: "",
      genre,
      // 例：「新潮文庫 ; つ-4-11」→「新潮文庫」
      series: pick(item, "seriesTitle").split(/\s*;\s*/)[0],
      cover: "",
    };
  }

  // ---- 整形 ----
  // ---- 著者名の整形 ----
  // 例）「筒井,康隆,1934-」→「筒井康隆」 「今村, 翔吾, 1984-」→「今村翔吾」
  //     「オースター, ポール, 1947-」→「ポール・オースター」 「Auster,Paul」→「Paul Auster」
  //     「東野圭吾／著」→「東野圭吾」 「松岡佑子／訳」→「松岡佑子（訳）」
  //     「今村、翔吾、1984-」（以前の版で崩れた形）→「今村翔吾」
  const YEAR_RE = /^\d{3,4}(\.\d{1,2})?-?(\d{3,4}(\.\d{1,2})?)?$/;
  const DROP_ROLES = /^(著|作|著者|文|作・文|作者)$/;

  function isYear(x) {
    return YEAR_RE.test(x);
  }

  // 「姓,名」の並びを読みやすい形にする
  function joinNameParts(segs) {
    if (!segs.length) return "";
    if (segs.length === 1) return segs[0];
    if (segs.every((x) => /^[\u30A0-\u30FF・ー＝=]+$/.test(x))) return segs.slice(1).concat(segs[0]).join("・"); // カタカナの外国人名
    if (segs.every((x) => /[^\x00-\x7F]/.test(x))) return segs.join(""); // 日本人名
    return segs.slice(1).concat(segs[0]).join(" "); // ローマ字
  }

  function cleanPerson(p) {
    let name = p.trim();
    let role = "";
    const m = name.match(/^(.*?)\s*／\s*(.+)$/);
    if (m) {
      name = m[1];
      role = m[2].trim();
    }
    if (name.includes(",")) name = joinNameParts(name.split(",").map((x) => x.trim()).filter((x) => x && !isYear(x)));
    if (!name) return "";
    return role && !DROP_ROLES.test(role) ? name + "（" + role + "）" : name;
  }

  // 以前の版で「、」区切りに崩れてしまった図書館式を、人ごとのまとまりに戻す
  function repairBrokenLibraryStyle(s) {
    const tokens = s.split("、");
    if (!tokens.some(isYear)) return s;
    const people = [];
    let cur = [];
    tokens.forEach((t) => {
      if (isYear(t.trim())) {
        if (cur.length) people.push(joinNameParts(cur));
        cur = [];
      } else {
        cur.push(t.trim());
      }
    });
    if (cur.length) people.push(...cur);
    return people.filter(Boolean).join("、");
  }

  function cleanAuthor(raw) {
    let s = String(raw || "")
      .replace(/[\s\u3000]+/g, " ")
      .replace(/\s*[,，]\s*/g, ",")
      .replace(/\s*[/／]\s*/g, "／")
      .trim();
    if (!s) return "";
    s = repairBrokenLibraryStyle(s);
    if (!s.includes(",") && !s.includes("／")) return s;
    let people;
    if (s.includes("／")) {
      // 「名前／役割 名前／役割」：役割の後の空白で人を区切る
      people = s.replace(/(／[^\s／]+)\s+/g, "$1\u0001").split("\u0001");
    } else {
      // 図書館式は空白で人を区切る（「山田,太郎 鈴木,花子」）
      people = s.split(" ");
    }
    return people.map(cleanPerson).filter(Boolean).join("、");
  }


  // 「20000101」「2000-01」「2000年01月上旬」などを「2000-01-01」「2000-01」形式にそろえる
  function normalizeDate(raw) {
    const s = String(raw || "").trim();
    let m = s.match(/^(\d{4})(\d{2})(\d{2})$/) || s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
    m = s.match(/^(\d{4})(\d{2})$/) || s.match(/^(\d{4})[-/.年](\d{1,2})/);
    if (m) return m[1] + "-" + m[2].padStart(2, "0");
    m = s.match(/^(\d{4})/);
    return m ? m[1] : "";
  }

  function formatDate(raw) {
    // 古い版で保存した「200211」のような形式もここでそろえる
    const d = normalizeDate(raw);
    if (!d) return "";
    const p = d.split("-");
    return p[0] + "年" + (p[1] ? Number(p[1]) + "月" : "") + (p[2] ? Number(p[2]) + "日" : "");
  }

  function formatPrice(p) {
    return p ? Number(p).toLocaleString("ja-JP") + "円" : "";
  }

  // 書誌の詳細を「項目名, 値」の配列で返す（表示用）
  function detailRows(b) {
    return [
      ["発売日", formatDate(b.pubdate)],
      ["価格", formatPrice(b.price)],
      ["ページ数", b.pages ? b.pages + "ページ" : ""],
      ["判型", b.form],
      ["ジャンル", b.genre],
      ["シリーズ", b.series],
    ].filter((r) => r[1]);
  }

  const SOURCE_NAMES = { openbd: "openBD", ndl: "国立国会図書館", google: "Google Books" };

  function hanmotoUrl(isbn) {
    return "https://www.hanmoto.com/bd/isbn/" + isbn;
  }

  function hanmotoLink(isbn) {
    const a = document.createElement("a");
    a.href = hanmotoUrl(isbn);
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "ext-link";
    a.textContent = "📖 版元ドットコムで見る";
    return a;
  }

  // ---------- 表示用の部品 ----------

  function coverElement(book, className) {
    if (book.cover) {
      const img = document.createElement("img");
      img.src = book.cover;
      img.alt = book.title;
      img.loading = "lazy";
      if (className) img.className = className;
      img.addEventListener("error", () => {
        const ph = document.createElement("div");
        ph.className = (className ? className + " " : "") + "no-cover";
        ph.textContent = "表紙なし";
        img.replaceWith(ph);
      });
      return img;
    }
    const div = document.createElement("div");
    div.className = (className ? className + " " : "") + "no-cover";
    div.textContent = "表紙なし";
    return div;
  }

  // ---------- 目録データ ----------

  function loadCatalog() {
    try {
      const data = JSON.parse(localStorage.getItem(CATALOG_KEY));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function saveCatalog(list) {
    try {
      localStorage.setItem(CATALOG_KEY, JSON.stringify(list));
      return true;
    } catch (err) {
      console.error(err);
      showError("保存できませんでした（端末の保存容量が不足している可能性があります）。バックアップを書き出してください。");
      return false;
    }
  }

  function findInCatalog(isbn) {
    return loadCatalog().find((b) => b.isbn === isbn) || null;
  }

  function toRecord(book) {
    return {
      isbn: book.isbn,
      title: book.title || "(タイトル不明)",
      author: book.author || "",
      publisher: book.publisher || "",
      pubdate: book.pubdate || "",
      price: book.price || "",
      pages: book.pages || "",
      form: book.form || "",
      genre: book.genre || "",
      series: book.series || "",
      cover: book.cover || "",
      sources: Array.isArray(book.sources) ? book.sources : [],
      location: book.location || "",
      status: STATUSES.includes(book.status) ? book.status : "未読",
      memo: book.memo || "",
      owned: book.owned !== false,
      owner: normalizeOwner(book.owner),
      releasedAt: book.releasedAt || "",
      releaseNote: book.releaseNote || "",
      addedAt: book.addedAt || new Date().toISOString(),
    };
  }

  // 持ち主が無い古いデータは「自分」の本として扱う
  function normalizeOwner(o) {
    return o === BOTH || OWNERS.includes(o) ? o : DEFAULT_OWNER;
  }

  function ownerOf(b) {
    return normalizeOwner(b.owner);
  }

  // 指定した人の本か（「両方」は2人ともの本）
  function belongsTo(b, person) {
    const o = ownerOf(b);
    return o === person || o === BOTH;
  }

  function getCurrentOwner() {
    return currentOwner;
  }

  // 古いデータには owned が無いので「持っている」とみなす
  function isOwned(b) {
    return b.owned !== false;
  }

  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function setOwner(isbn, owner) {
    const list = loadCatalog();
    const b = list.find((x) => x.isbn === isbn);
    if (!b) return;
    b.owner = normalizeOwner(owner);
    saveCatalog(list);
    renderCatalog();
  }

  // 手放した本を「持っている」に戻す。手放した記録はメモに残す
  function restoreOwnership(isbn) {
    const list = loadCatalog();
    const b = list.find((x) => x.isbn === isbn);
    if (!b) return null;
    const history = "【" + (formatDate(b.releasedAt) || "日付不明") + " 手放した" + (b.releaseNote ? "：" + b.releaseNote : "") + "】";
    b.memo = [b.memo, history].filter(Boolean).join("\n");
    b.owned = true;
    b.releasedAt = "";
    b.releaseNote = "";
    saveCatalog(list);
    renderCatalog();
    return b;
  }

  // 追加できたら true、登録済みなら false
  function addBookRecord(book) {
    const list = loadCatalog();
    if (list.some((b) => b.isbn === book.isbn)) return false;
    list.unshift(toRecord(book));
    if (!saveCatalog(list)) return false;
    renderCatalog();
    return true;
  }

  async function addIsbnToCatalog(isbn) {
    clearError();
    const existing = findInCatalog(isbn);
    if (existing && !isOwned(existing)) {
      vibrate([60, 60, 60]);
      const when = formatDate(existing.releasedAt);
      const ok = confirm(
        "「" + existing.title + "」は" + (when ? when + "に" : "以前") + "手放した本です。\n" +
          "また持っている本に戻しますか？（手放した記録はメモに残ります）"
      );
      if (ok) {
        restoreOwnership(isbn);
        setOwner(isbn, getCurrentOwner());
        toast("持っている本に戻しました: " + existing.title, "ok");
      } else {
        toast("以前手放した本です: " + existing.title, "warn");
      }
      return;
    }
    if (existing) {
      vibrate([60, 60, 60]);
      const me = getCurrentOwner();
      const cur = ownerOf(existing);
      if (cur !== me && cur !== BOTH) {
        const ok = confirm(
          "「" + existing.title + "」は" + cur + "の本として登録済みです。\n" +
            me + "も持っている本（" + BOTH + "）にしますか？"
        );
        if (ok) {
          setOwner(isbn, BOTH);
          toast(BOTH + "の本にしました: " + existing.title, "ok");
        } else {
          toast(cur + "の本として登録済み: " + existing.title, "warn");
        }
        return;
      }
      toast("登録済み: " + existing.title, "warn");
      return;
    }
    lookupBusy = true;
    scanStatus.textContent = "書誌情報を取得中... (" + isbn + ")";
    try {
      let book = null;
      try {
        book = await fetchBook(isbn);
      } catch (err) {
        console.error(err);
        showError("通信エラーのため書誌情報を取得できませんでした。ISBNのみで登録したので、あとで編集してください。");
      }
      const notFound = !book;
      if (!book) book = { isbn, title: "(書誌情報なし) ISBN " + isbn };
      const owner = getCurrentOwner();
      book.owner = owner;
      if (addBookRecord(book)) {
        vibrate(120);
        const who = owner === DEFAULT_OWNER ? "" : "【" + owner + "】";
        toast(who + (notFound ? "ISBNのみ登録: " : "追加: ") + book.title, notFound ? "warn" : "ok");
      }
    } finally {
      lookupBusy = false;
      scanStatus.textContent = isScanning ? scanHint() : "";
    }
  }

  // ---------- 目録の表示 ----------

  function renderCatalog() {
    const list = loadCatalog();
    if (document.getElementById("backup-reminder")) renderBackupReminder();
    const q = catalogSearch.value.trim().toLowerCase();
    const status = catalogStatusFilter.value;
    const mine = ownerView ? list.filter((b) => belongsTo(b, ownerView)) : list;
    const ownedList = mine.filter(isOwned);
    const base = ownedView === "released" ? mine.filter((b) => !isOwned(b)) : ownedList;
    $("owned-count").textContent = ownedList.length + "冊";
    $("released-count").textContent = mine.length - ownedList.length + "冊";
    document.querySelectorAll(".owner-tab").forEach((t) => {
      const who = t.dataset.owner;
      const n = list.filter((b) => isOwned(b) && (!who || belongsTo(b, who))).length;
      t.querySelector("span").textContent = n + "冊";
    });
    const filtered = base.filter((b) => {
      if (status && b.status !== status) return false;
      if (!q) return true;
      return [b.title, b.author, b.publisher, b.series, b.genre, b.form, b.location, b.memo, b.releaseNote, b.isbn]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });

    catalogCount.textContent =
      filtered.length === base.length ? base.length + "冊" : filtered.length + " / " + base.length + "冊";

    catalogList.innerHTML = "";
    catalogEmpty.hidden = filtered.length > 0;
    catalogEmpty.textContent = base.length
      ? "条件に合う本がありません。"
      : ownedView === "released"
      ? "手放した本はありません。本の編集画面で「所持」を「手放した」にすると、ここに移ります。"
      : "まだ登録がありません。上のボタンからスキャンを始めてください。";

    const frag = document.createDocumentFragment();
    filtered.forEach((b) => {
      const li = document.createElement("li");
      li.appendChild(coverElement(b, "c-cover"));

      const body = document.createElement("div");
      body.className = "c-body";
      const title = document.createElement("div");
      title.className = "c-title";
      title.textContent = b.title;
      const sub = document.createElement("div");
      sub.className = "c-sub";
      sub.textContent = [b.author, b.publisher].filter(Boolean).join(" / ");
      const meta = document.createElement("div");
      meta.className = "c-meta";
      const st = document.createElement("span");
      st.className = "c-status c-status-" + STATUSES.indexOf(b.status);
      st.textContent = b.status;
      meta.appendChild(st);
      if (ownerOf(b) !== DEFAULT_OWNER) {
        const ow = document.createElement("span");
        ow.className = "c-owner c-owner-" + (ownerOf(b) === BOTH ? "both" : "other");
        ow.textContent = ownerOf(b);
        meta.appendChild(ow);
      }
      [b.form, b.genre].filter(Boolean).forEach((t) => {
        const tag = document.createElement("span");
        tag.className = "c-tag";
        tag.textContent = t;
        meta.appendChild(tag);
      });
      if (!isOwned(b)) {
        li.classList.add("is-released");
        const rel = document.createElement("span");
        rel.className = "c-released";
        rel.textContent = "手放した" + (b.releasedAt ? " " + formatDate(b.releasedAt) : "");
        meta.appendChild(rel);
      }
      if (b.location) {
        const loc = document.createElement("span");
        loc.textContent = "📍" + b.location;
        meta.appendChild(loc);
      }
      body.append(title, sub, meta);
      li.appendChild(body);

      li.addEventListener("click", () => openEditor(b.isbn));
      frag.appendChild(li);
    });
    catalogList.appendChild(frag);
  }

  catalogSearch.addEventListener("input", renderCatalog);
  catalogStatusFilter.addEventListener("change", renderCatalog);

  document.querySelectorAll(".owner-tab").forEach((t) =>
    t.addEventListener("click", () => {
      ownerView = t.dataset.owner;
      document.querySelectorAll(".owner-tab").forEach((x) => x.classList.toggle("is-active", x === t));
      renderCatalog();
    })
  );

  document.querySelectorAll(".owned-tab").forEach((t) =>
    t.addEventListener("click", () => {
      ownedView = t.dataset.owned;
      document.querySelectorAll(".owned-tab").forEach((x) => x.classList.toggle("is-active", x === t));
      renderCatalog();
    })
  );

  // ---------- 編集 ----------

  function openEditor(isbn) {
    const b = findInCatalog(isbn);
    if (!b) return;
    editingIsbn = isbn;
    $("edit-title").value = b.title || "";
    $("edit-author").value = b.author || "";
    $("edit-publisher").value = b.publisher || "";
    $("edit-location").value = b.location || "";
    $("edit-status").value = STATUSES.includes(b.status) ? b.status : "未読";
    $("edit-owned").value = isOwned(b) ? "owned" : "released";
    $("edit-owner").value = ownerOf(b);
    $("edit-released-at").value = b.releasedAt || "";
    $("edit-release-note").value = b.releaseNote || "";
    toggleReleaseFields();
    $("edit-memo").value = b.memo || "";
    $("edit-meta").textContent =
      "ISBN " + b.isbn + "　登録日 " + new Date(b.addedAt).toLocaleDateString("ja-JP");
    renderEditDetails(b);

    const locations = [...new Set(loadCatalog().map((x) => x.location).filter(Boolean))];
    const dl = $("location-options");
    dl.innerHTML = "";
    locations.forEach((l) => {
      const o = document.createElement("option");
      o.value = l;
      dl.appendChild(o);
    });

    editDialog.showModal();
    // iPhone で開いた瞬間にキーボードが出ないよう、入力欄にカーソルを置かない
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) active.blur();
    editDialog.scrollTop = 0;
  }

  function toggleReleaseFields() {
    const released = $("edit-owned").value === "released";
    $("release-fields").hidden = !released;
    if (released && !$("edit-released-at").value) $("edit-released-at").value = todayStr();
  }
  $("edit-owned").addEventListener("change", toggleReleaseFields);

  function renderEditDetails(b) {
    const box = $("edit-details");
    box.innerHTML = "";
    const rows = detailRows(b);
    const names = (b.sources || []).map((x) => SOURCE_NAMES[x]).filter(Boolean);
    if (names.length) rows.push(["情報元", names.join("・")]);
    if (rows.length) {
      const dl = document.createElement("dl");
      rows.forEach(([k, v]) => {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = v;
        dl.append(dt, dd);
      });
      box.appendChild(dl);
    }
    box.appendChild(hanmotoLink(b.isbn));
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "edit-meta";
      p.textContent = "詳しい情報はまだありません。「情報を再取得」を押すと探し直します。";
      box.appendChild(p);
    }
  }

  // 空いている項目だけを新しく取得した情報で埋める（手で直したタイトルなどは上書きしない）
  function mergeInto(record, fresh) {
    let changed = 0;
    FIELDS.forEach((k) => {
      if (!fresh[k]) return;
      const isPlaceholder = k === "title" && /^\(書誌情報なし\)|^\(タイトル不明\)/.test(record.title || "");
      // 図書館式（「筒井,康隆,1934-」）や、以前の版で崩れた「今村、翔吾、1984-」も直す
      const isLibraryAuthor = k === "author" && /[,，、]\s*\d{4}-/.test(record.author || "");
      // 英語だけの著者名は、日本語の表記が見つかれば置き換える
      const isNonJapaneseAuthor = k === "author" && !hasJapanese(record.author) && hasJapanese(fresh.author);
      if (!record[k] || isPlaceholder || isLibraryAuthor || isNonJapaneseAuthor) {
        if (record[k] !== fresh[k]) {
          record[k] = fresh[k];
          changed++;
        }
      }
    });
    // 情報元は「いま目録に入っている値」がどこから来たかで決め直す
    // （手で直した項目は一致しないので数えない。以前の版の「見つかった情報源すべて」の表示もここで直る）
    const fs = fresh.fieldSources || {};
    const attributed = {};
    FIELDS.forEach((k) => {
      if (record[k] && fs[k] && record[k] === fresh[k]) attributed[k] = fs[k];
    });
    const recomputed = sourcesUsed(attributed);
    if (recomputed.length) record.sources = recomputed;
    return changed;
  }

  async function refreshRecord(isbn) {
    const fresh = await fetchBook(isbn);
    if (!fresh) return 0;
    const list = loadCatalog();
    const rec = list.find((x) => x.isbn === isbn);
    if (!rec) return 0;
    const changed = mergeInto(rec, fresh);
    saveCatalog(list);
    return changed;
  }

  $("edit-refresh-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "取得中...";
    try {
      const before = findInCatalog(editingIsbn) || {};
      const changed = await refreshRecord(editingIsbn);
      const b = findInCatalog(editingIsbn);
      if (b) {
        // 新しく補われた項目だけを画面に反映（入力途中の内容は消さない）
        [["title", "edit-title"], ["author", "edit-author"], ["publisher", "edit-publisher"]].forEach(([k, id]) => {
          if (b[k] !== before[k] && !$(id).value.trim()) $(id).value = b[k];
          else if (b[k] !== before[k] && $(id).value === (before[k] || "")) $(id).value = b[k];
        });
        renderEditDetails(b);
      }
      toast(changed ? changed + "項目を補いました" : "新しい情報は見つかりませんでした", changed ? "ok" : "");
      renderCatalog();
    } catch (err) {
      console.error(err);
      toast("取得に失敗しました。通信状況を確認してください", "warn");
    } finally {
      btn.disabled = false;
      btn.textContent = "🔄 情報を再取得";
    }
  });

  editForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const list = loadCatalog();
    const b = list.find((x) => x.isbn === editingIsbn);
    if (b) {
      b.title = $("edit-title").value.trim() || b.title;
      b.author = $("edit-author").value.trim();
      b.publisher = $("edit-publisher").value.trim();
      b.location = $("edit-location").value.trim();
      b.status = $("edit-status").value;
      b.memo = $("edit-memo").value.trim();
      b.owner = normalizeOwner($("edit-owner").value);
      const wasOwned = isOwned(b);
      b.owned = $("edit-owned").value !== "released";
      b.releasedAt = b.owned ? "" : $("edit-released-at").value || todayStr();
      b.releaseNote = b.owned ? "" : $("edit-release-note").value.trim();
      saveCatalog(list);
      if (wasOwned && !b.owned) toast("「手放した本」に移しました");
      if (!wasOwned && b.owned) toast("「持っている本」に戻しました", "ok");
    }
    editDialog.close();
    renderCatalog();
  });

  $("edit-cancel-btn").addEventListener("click", () => editDialog.close());

  $("edit-delete-btn").addEventListener("click", () => {
    const b = findInCatalog(editingIsbn);
    if (!b || !confirm("「" + b.title + "」を目録から削除しますか？")) return;
    saveCatalog(loadCatalog().filter((x) => x.isbn !== editingIsbn));
    editDialog.close();
    renderCatalog();
    toast("削除しました");
  });

  // ---------- 書き出し・読み込み ----------

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Excel で行が高くならないよう、改行をスペースに置き換えて1行にする
  function oneLine(v) {
    return String(v || "").replace(/\s*[\r\n]+\s*/g, " ").trim();
  }

  // Excel に書き出す列（width は列幅、文字数の目安）
  const EXPORT_COLUMNS = [
    { header: "タイトル", width: 40, get: (b) => b.title },
    { header: "著者", width: 18, get: (b) => b.author },
    { header: "出版社", width: 14, get: (b) => b.publisher },
    { header: "発売日", width: 14, get: (b) => formatDate(b.pubdate) },
    { header: "価格", width: 8, type: "number", get: (b) => b.price || "" },
    { header: "ページ数", width: 9, type: "number", get: (b) => b.pages || "" },
    { header: "判型", width: 9, get: (b) => b.form || "" },
    { header: "ジャンル", width: 18, get: (b) => b.genre || "" },
    { header: "シリーズ", width: 16, get: (b) => b.series || "" },
    { header: "ISBN", width: 16, get: (b) => b.isbn },
    { header: "置き場所", width: 16, get: (b) => b.location || "" },
    { header: "状態", width: 8, get: (b) => b.status },
    { header: "持ち主", width: 8, get: (b) => ownerOf(b) },
    { header: "所持", width: 11, get: (b) => (isOwned(b) ? "持っている" : "手放した") },
    { header: "手放した日", width: 14, get: (b) => formatDate(b.releasedAt) },
    { header: "手放し方・売却先", width: 22, get: (b) => b.releaseNote || "" },
    { header: "メモ", width: 32, get: (b) => oneLine(b.memo) },
    { header: "登録日", width: 12, get: (b) => new Date(b.addedAt).toLocaleDateString("ja-JP") },
  ];

  function exportRows(list) {
    return list.map((b) => EXPORT_COLUMNS.map((c) => c.get(b)));
  }

  // iCloud Drive などに同じ名前で上書き保存できるよう、ファイル名は固定にする
  const XLSX_FILENAME = "蔵書目録.xlsx";
  const BACKUP_FILENAME = "蔵書バックアップ.json";
  const LAST_BACKUP_KEY = "last-backup-at";
  const SNOOZE_KEY = "backup-reminder-snooze-until";
  const BACKUP_REMIND_DAYS = 14;
  const SNOOZE_DAYS = 3;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function backupJson(list) {
    return JSON.stringify(
      { app: "book-post-generator", version: 1, exportedAt: new Date().toISOString(), books: list },
      null,
      2
    );
  }

  function markBackedUp() {
    try {
      localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
      localStorage.removeItem(SNOOZE_KEY);
    } catch {}
    renderBackupReminder();
  }

  // Excel（見る用）とバックアップ（戻す用）を一緒に書き出す
  async function exportExcelAndBackup() {
    const list = loadCatalog();
    if (!list.length) {
      backupStatus.textContent = "書き出す本がありません";
      return;
    }
    if (!window.XlsxWriter) {
      backupStatus.textContent = "Excel書き出しの部品を読み込めませんでした。ページを再読み込みしてください";
      return;
    }
    const xlsx = XlsxWriter.build({ sheetName: "蔵書目録", columns: EXPORT_COLUMNS, rows: exportRows(list) });
    const json = new Blob([backupJson(list)], { type: "application/json" });
    const files = [
      new File([xlsx], XLSX_FILENAME, { type: xlsx.type }),
      new File([json], BACKUP_FILENAME, { type: "application/json" }),
    ];
    const done = () => {
      markBackedUp();
      backupStatus.textContent = list.length + "冊分のExcelとバックアップを書き出しました";
    };
    // iPhone では共有画面を開き、「"ファイル"に保存」やショートカットで iCloud Drive に保存できる
    if (navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files, title: "蔵書目録" });
        done();
      } catch (err) {
        if (err && err.name === "AbortError") {
          backupStatus.textContent = "書き出しをキャンセルしました";
          return;
        }
        console.error(err);
        download(XLSX_FILENAME, xlsx, xlsx.type);
        download(BACKUP_FILENAME, json, "application/json");
        done();
      }
      return;
    }
    download(XLSX_FILENAME, xlsx, xlsx.type);
    download(BACKUP_FILENAME, json, "application/json");
    done();
  }

  $("export-xlsx-btn").addEventListener("click", exportExcelAndBackup);

  // ---------- バックアップのお知らせ ----------

  function readTime(key) {
    try {
      const v = localStorage.getItem(key);
      const t = v ? Date.parse(v) : NaN;
      return isNaN(t) ? null : t;
    } catch {
      return null;
    }
  }

  function renderBackupReminder() {
    const box = $("backup-reminder");
    const list = loadCatalog();
    const last = readTime(LAST_BACKUP_KEY);
    const snoozeUntil = readTime(SNOOZE_KEY);
    const now = Date.now();
    $("last-backup").textContent = last
      ? "前回のバックアップ：" + new Date(last).toLocaleDateString("ja-JP")
      : "まだバックアップしていません";
    let message = "";
    if (list.length && !last) {
      message = "まだバックアップしていません。万一に備えて、iCloudに保存しておきましょう。";
    } else if (list.length && now - last >= BACKUP_REMIND_DAYS * DAY_MS) {
      const days = Math.floor((now - last) / DAY_MS);
      message = "前回のバックアップから" + days + "日たちました。iCloudに保存しておきましょう。";
    }
    if (!message || (snoozeUntil && now < snoozeUntil)) {
      box.hidden = true;
      return;
    }
    $("backup-reminder-text").textContent = message;
    box.hidden = false;
  }

  $("backup-reminder-now").addEventListener("click", exportExcelAndBackup);
  $("backup-reminder-later").addEventListener("click", () => {
    try {
      localStorage.setItem(SNOOZE_KEY, new Date(Date.now() + SNOOZE_DAYS * DAY_MS).toISOString());
    } catch {}
    renderBackupReminder();
  });

  // 端末の容量が足りなくなっても、このアプリのデータを自動で消さないよう申請する
  async function requestPersistentStorage() {
    const el = $("storage-persist");
    try {
      if (!navigator.storage || !navigator.storage.persist) {
        el.textContent = "";
        return;
      }
      let persisted = await navigator.storage.persisted();
      if (!persisted) persisted = await navigator.storage.persist();
      el.textContent = persisted
        ? "🔒 この端末に、データを自動で消さないよう設定済みです"
        : "※ この端末では自動削除を止める設定が使えないため、バックアップを定期的に保存してください";
    } catch (err) {
      console.error(err);
      el.textContent = "";
    }
  }

  $("import-json-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const books = Array.isArray(data) ? data : data && data.books;
      if (!Array.isArray(books)) throw new Error("invalid format");
      const list = loadCatalog();
      const known = new Set(list.map((b) => b.isbn));
      let added = 0;
      books.forEach((raw) => {
        const isbn = raw && normalizeIsbn(raw.isbn);
        if (!isbn || known.has(isbn)) return;
        list.push(toRecord({ ...raw, isbn }));
        known.add(isbn);
        added++;
      });
      if (saveCatalog(list)) {
        renderCatalog();
        backupStatus.textContent =
          added + "冊を読み込みました（登録済みの " + (books.length - added) + "冊はそのまま）";
      }
    } catch (err) {
      console.error(err);
      backupStatus.textContent = "読み込めませんでした。このアプリで保存したバックアップファイルか確認してください。";
    }
  });

  // ---------- 著者名の点検 ----------

  function renderAuthorCheck() {
    const box = $("author-check");
    const list = loadCatalog().filter((b) => b.author && !hasJapanese(b.author));
    if (!list.length) {
      box.innerHTML = "";
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = "✅ 英語（ローマ字）だけの著者名はありません。";
      box.appendChild(p);
      return;
    }
    box.innerHTML = "";
    const p = document.createElement("p");
    p.className = "note";
    p.textContent =
      "英語（ローマ字）だけの著者名が" + list.length + "冊あります。「まとめて情報を補う」で日本語の表記が見つかれば置き換わります。見つからない本は、押して編集画面で直してください。";
    const ul = document.createElement("ul");
    ul.className = "author-check-list";
    list.forEach((b) => {
      const li = document.createElement("li");
      li.textContent = b.title + " ／ " + b.author;
      li.addEventListener("click", () => openEditor(b.isbn));
      ul.appendChild(li);
    });
    box.append(p, ul);
  }

  document.querySelector("#settings-section details").addEventListener("toggle", (e) => {
    if (e.target.open) renderAuthorCheck();
  });

  // ---------- まとめて情報を補う ----------

  let bulkRunning = false;
  $("bulk-refresh-btn").addEventListener("click", async (e) => {
    if (bulkRunning) {
      bulkRunning = false;
      return;
    }
    const isbns = loadCatalog().map((b) => b.isbn);
    const bulkStatus = $("bulk-status");
    if (!isbns.length) {
      bulkStatus.textContent = "目録に本がありません";
      return;
    }
    const btn = e.currentTarget;
    bulkRunning = true;
    btn.textContent = "⏹ 中止する";
    let done = 0;
    let improved = 0;
    let failed = 0;
    for (const isbn of isbns) {
      if (!bulkRunning) break;
      bulkStatus.textContent = "情報を探しています… " + done + " / " + isbns.length + "冊";
      try {
        if ((await refreshRecord(isbn)) > 0) improved++;
      } catch (err) {
        console.error(err);
        failed++;
      }
      done++;
      // 各サービスに負担をかけないよう間隔をあける
      await new Promise((r) => setTimeout(r, 400));
    }
    bulkStatus.textContent =
      (bulkRunning ? "完了：" : "中止しました：") + done + "冊を確認、" + improved + "冊の情報を補いました" +
      (failed ? "（" + failed + "冊は通信エラー）" : "");
    bulkRunning = false;
    btn.textContent = "🔄 まとめて情報を補う";
    renderCatalog();
    renderAuthorCheck();
  });

  // ---------- 起動 ----------

  // 著者名の表記を点検して、図書館式や崩れた書き方を直す（何度実行しても同じ結果）
  (function fixAuthorNames() {
    const list = loadCatalog();
    let fixed = 0;
    list.forEach((b) => {
      const cleaned = cleanAuthor(b.author || "");
      if (cleaned !== (b.author || "")) {
        b.author = cleaned;
        fixed++;
      }
    });
    if (fixed) {
      saveCatalog(list);
      setTimeout(() => toast("著者名の表記を" + fixed + "冊分そろえました", "ok"), 600);
    }
  })();

  // 以前の版で目録に保存していた内容紹介を取り除く
  (function dropStoredDescriptions() {
    const list = loadCatalog();
    if (list.some((b) => "description" in b)) {
      list.forEach((b) => delete b.description);
      saveCatalog(list);
    }
  })();

  // 投稿文作成の機能は廃止したので、そのために保存していたデータを消す
  try {
    localStorage.removeItem("book-scan-history");
    localStorage.removeItem("book-scan-mode");
  } catch {}

  // 以前の版で保存されていた楽天の設定が残っていれば消す
  try {
    localStorage.removeItem("rakuten-settings");
  } catch {}

  renderOwnerPicker();
  renderCatalog();
  renderBackupReminder();
  requestPersistentStorage();
})();

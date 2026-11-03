(() => {
  "use strict";

  const HASHTAGS = "#読書 #読書記録 #読書好きな人と繋がりたい #本 #book #bookstagram #読了 #本好き";
  const HISTORY_KEY = "book-scan-history";
  const HISTORY_LIMIT = 30;
  const CATALOG_KEY = "book-catalog";
  const MODE_KEY = "book-scan-mode";
  const SAME_ISBN_COOLDOWN_MS = 4000;
  const STATUSES = ["未読", "読書中", "読了"];

  const $ = (id) => document.getElementById(id);

  const readerEl = $("reader");
  const startBtn = $("start-scan-btn");
  const stopBtn = $("stop-scan-btn");
  const scanStatus = $("scan-status");
  const manualForm = $("manual-form");
  const manualInput = $("manual-isbn");
  const resultSection = $("result-section");
  const bookInfoEl = $("book-info");
  const postTextEl = $("post-text");
  const copyBtn = $("copy-btn");
  const copyStatus = $("copy-status");
  const addToCatalogBtn = $("add-to-catalog-btn");
  const errorSection = $("error-section");
  const errorMessageEl = $("error-message");
  const historySection = $("history-section");
  const historyList = $("history-list");
  const subtitleEl = $("mode-subtitle");
  const tabs = document.querySelectorAll(".tab");
  const badgeEl = $("catalog-count-badge");
  const catalogSection = $("catalog-section");
  const backupSection = $("backup-section");
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
  let mode = "post";
  let currentBook = null;
  let lastScan = { isbn: "", time: 0 };
  let lookupBusy = false;
  let editingIsbn = null;

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

  // ---------- モード切替 ----------

  function setMode(next) {
    mode = next;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {}
    tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.mode === mode));
    clearError();
    if (mode === "catalog") {
      subtitleEl.textContent = "バーコードを続けて読み取ると目録に登録されます";
      resultSection.hidden = true;
      historySection.hidden = true;
      catalogSection.hidden = false;
      backupSection.hidden = false;
      renderCatalog();
    } else {
      subtitleEl.textContent = "ISBNバーコードをスキャンして投稿文を作成";
      catalogSection.hidden = true;
      backupSection.hidden = true;
      resultSection.hidden = !currentBook;
      renderHistory();
    }
    if (isScanning) scanStatus.textContent = scanHint();
  }

  tabs.forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));

  function scanHint() {
    return mode === "catalog"
      ? "続けてバーコードを読み取れます（1冊ずつ枠内に）"
      : "本の裏表紙のバーコードを枠内に写してください";
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
    if (mode === "catalog") {
      const now = Date.now();
      if (lookupBusy) return;
      if (isbn === lastScan.isbn && now - lastScan.time < SAME_ISBN_COOLDOWN_MS) return;
      lastScan = { isbn, time: now };
      addIsbnToCatalog(isbn);
    } else {
      vibrate(120);
      stopScan("読み取りました: " + isbn);
      lookupForPost(isbn);
    }
  }

  startBtn.addEventListener("click", startScan);
  stopBtn.addEventListener("click", () => stopScan(""));
  // 画面を離れたらカメラを止める（電池の消耗と、iPhone で映像が固まるのを防ぐ）
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isScanning) stopScan("");
  });

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
    if (mode === "catalog") {
      addIsbnToCatalog(isbn);
    } else {
      lookupForPost(isbn);
    }
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
    if (mode === "catalog") {
      addIsbnToCatalog(isbn);
    } else {
      lookupForPost(isbn);
    }
  });

  // ---------- 書誌情報の取得 ----------

  async function fetchBook(isbn) {
    const res = await fetch("https://api.openbd.jp/v1/get?isbn=" + encodeURIComponent(isbn));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const entry = data && data[0];
    return entry ? extractBookInfo(entry, isbn) : null;
  }

  function extractBookInfo(entry, isbn) {
    const summary = entry.summary || {};
    let description = "";
    const textContents =
      entry.onix &&
      entry.onix.CollateralDetail &&
      entry.onix.CollateralDetail.TextContent;
    if (Array.isArray(textContents)) {
      const preferredOrder = ["03", "02", "04", "01"];
      for (const type of preferredOrder) {
        const match = textContents.find((t) => t.TextType === type && t.Text);
        if (match) {
          description = match.Text;
          break;
        }
      }
      if (!description && textContents[0] && textContents[0].Text) {
        description = textContents[0].Text;
      }
    }
    description = description
      .replace(/<[^>]+>/g, "")
      .replace(/\r\n/g, "\n")
      .trim();

    return {
      isbn,
      title: summary.title || "(タイトル不明)",
      author: (summary.author || "").replace(/\s+/g, " ").trim(),
      publisher: summary.publisher || "",
      pubdate: summary.pubdate || "",
      cover: summary.cover || "",
      description,
    };
  }

  // ---------- 投稿文モード ----------

  async function lookupForPost(isbn) {
    clearError();
    resultSection.hidden = true;
    scanStatus.textContent = "書誌情報を取得中...";
    try {
      const book = await fetchBook(isbn);
      scanStatus.textContent = "";
      if (!book) {
        showError("ISBN " + isbn + " の書誌情報が見つかりませんでした。");
        return;
      }
      renderBook(book);
      saveToHistory(book);
    } catch (err) {
      console.error(err);
      showError("書誌情報の取得に失敗しました。通信状況をご確認のうえ再度お試しください。");
      scanStatus.textContent = "";
    }
  }

  function buildPostText(book) {
    const lines = [];
    lines.push(book.title);
    if (book.author) lines.push(book.author);
    lines.push("");
    if (book.description) {
      lines.push(book.description);
      lines.push("");
    }
    lines.push(HASHTAGS);
    return lines.join("\n");
  }

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

  function renderBook(book) {
    currentBook = book;
    bookInfoEl.innerHTML = "";
    bookInfoEl.appendChild(coverElement(book));

    const dl = document.createElement("dl");
    dl.innerHTML =
      "<dt>タイトル</dt><dd>" + escapeHtml(book.title) + "</dd>" +
      "<dt>著者</dt><dd>" + escapeHtml(book.author || "-") + "</dd>" +
      "<dt>出版社</dt><dd>" + escapeHtml(book.publisher || "-") + "</dd>" +
      "<dt>ISBN</dt><dd>" + escapeHtml(book.isbn) + "</dd>";
    bookInfoEl.appendChild(dl);

    postTextEl.value = buildPostText(book);
    copyStatus.textContent = "";
    updateAddToCatalogBtn();
    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function updateAddToCatalogBtn() {
    const exists = currentBook && findInCatalog(currentBook.isbn);
    addToCatalogBtn.disabled = !!exists;
    addToCatalogBtn.textContent = exists ? "✓ 目録に登録済み" : "＋ 目録に追加";
  }

  addToCatalogBtn.addEventListener("click", () => {
    if (!currentBook) return;
    if (addBookRecord(currentBook)) toast("目録に追加しました", "ok");
    updateAddToCatalogBtn();
  });

  copyBtn.addEventListener("click", async () => {
    const text = postTextEl.value;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        postTextEl.select();
        document.execCommand("copy");
        window.getSelection().removeAllRanges();
      }
      copyStatus.textContent = "コピーしました！";
    } catch (err) {
      console.error(err);
      copyStatus.textContent = "コピーに失敗しました";
    }
    setTimeout(() => {
      copyStatus.textContent = "";
    }, 2500);
  });

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch {
      return [];
    }
  }

  function saveToHistory(book) {
    let history = loadHistory().filter((b) => b.isbn !== book.isbn);
    history.unshift(book);
    history = history.slice(0, HISTORY_LIMIT);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (err) {
      console.error(err);
    }
    renderHistory();
  }

  function removeFromHistory(isbn) {
    const history = loadHistory().filter((b) => b.isbn !== isbn);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    renderHistory();
  }

  function renderHistory() {
    const history = loadHistory();
    historyList.innerHTML = "";
    if (history.length === 0 || mode !== "post") {
      historySection.hidden = true;
      return;
    }
    historySection.hidden = false;
    history.forEach((book) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.className = "h-title";
      span.textContent = book.title;
      span.addEventListener("click", () => renderBook(book));

      const removeBtn = document.createElement("button");
      removeBtn.className = "h-remove";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFromHistory(book.isbn);
      });

      li.appendChild(span);
      li.appendChild(removeBtn);
      historyList.appendChild(li);
    });
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
      cover: book.cover || "",
      location: book.location || "",
      status: STATUSES.includes(book.status) ? book.status : "未読",
      memo: book.memo || "",
      addedAt: book.addedAt || new Date().toISOString(),
    };
  }

  // 追加できたら true、登録済みなら false
  function addBookRecord(book) {
    const list = loadCatalog();
    if (list.some((b) => b.isbn === book.isbn)) return false;
    list.unshift(toRecord(book));
    if (!saveCatalog(list)) return false;
    updateBadge(list.length);
    if (mode === "catalog") renderCatalog();
    return true;
  }

  async function addIsbnToCatalog(isbn) {
    clearError();
    const existing = findInCatalog(isbn);
    if (existing) {
      vibrate([60, 60, 60]);
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
      if (addBookRecord(book)) {
        vibrate(120);
        toast((notFound ? "ISBNのみ登録: " : "追加: ") + book.title, notFound ? "warn" : "ok");
      }
    } finally {
      lookupBusy = false;
      scanStatus.textContent = isScanning ? scanHint() : "";
    }
  }

  function updateBadge(n) {
    badgeEl.textContent = String(n === undefined ? loadCatalog().length : n);
  }

  // ---------- 目録の表示 ----------

  function renderCatalog() {
    const list = loadCatalog();
    const q = catalogSearch.value.trim().toLowerCase();
    const status = catalogStatusFilter.value;
    const filtered = list.filter((b) => {
      if (status && b.status !== status) return false;
      if (!q) return true;
      return [b.title, b.author, b.publisher, b.location, b.memo, b.isbn]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });

    updateBadge(list.length);
    catalogCount.textContent =
      filtered.length === list.length ? list.length + "冊" : filtered.length + " / " + list.length + "冊";

    catalogList.innerHTML = "";
    catalogEmpty.hidden = filtered.length > 0;
    catalogEmpty.textContent = list.length
      ? "条件に合う本がありません。"
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

  // ---------- 編集 ----------

  function openEditor(isbn) {
    const b = findInCatalog(isbn);
    if (!b) return;
    editingIsbn = isbn;
    $("edit-title").value = b.title;
    $("edit-author").value = b.author;
    $("edit-publisher").value = b.publisher;
    $("edit-location").value = b.location;
    $("edit-status").value = b.status;
    $("edit-memo").value = b.memo;
    $("edit-meta").textContent =
      "ISBN " + b.isbn + "　登録日 " + new Date(b.addedAt).toLocaleDateString("ja-JP");

    const locations = [...new Set(loadCatalog().map((x) => x.location).filter(Boolean))];
    const dl = $("location-options");
    dl.innerHTML = "";
    locations.forEach((l) => {
      const o = document.createElement("option");
      o.value = l;
      dl.appendChild(o);
    });

    editDialog.showModal();
  }

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
      saveCatalog(list);
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

  function dateStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  function csvCell(v) {
    const s = String(v == null ? "" : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  $("export-csv-btn").addEventListener("click", () => {
    const list = loadCatalog();
    if (!list.length) {
      backupStatus.textContent = "書き出す本がありません";
      return;
    }
    const header = ["タイトル", "著者", "出版社", "出版日", "ISBN", "置き場所", "状態", "メモ", "登録日"];
    const rows = list.map((b) => [
      b.title,
      b.author,
      b.publisher,
      b.pubdate,
      // Excelで数値扱い（指数表示）にならないよう文字列として出力
      '="' + b.isbn + '"',
      b.location,
      b.status,
      b.memo,
      new Date(b.addedAt).toLocaleDateString("ja-JP"),
    ]);
    const csv = [header, ...rows]
      .map((r, i) => r.map((c, j) => (i > 0 && j === 4 ? c : csvCell(c))).join(","))
      .join("\r\n");
    // 先頭のBOMでExcelが文字化けせずに開ける
    download("蔵書目録_" + dateStamp() + ".csv", "﻿" + csv, "text/csv;charset=utf-8");
    backupStatus.textContent = list.length + "冊をCSVで書き出しました";
  });

  $("export-json-btn").addEventListener("click", () => {
    const list = loadCatalog();
    const payload = { app: "book-post-generator", version: 1, exportedAt: new Date().toISOString(), books: list };
    download("蔵書バックアップ_" + dateStamp() + ".json", JSON.stringify(payload, null, 2), "application/json");
    backupStatus.textContent = list.length + "冊をバックアップしました";
  });

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

  // ---------- 起動 ----------

  updateBadge();
  let savedMode = "post";
  try {
    savedMode = localStorage.getItem(MODE_KEY) || "post";
  } catch {}
  setMode(savedMode === "catalog" ? "catalog" : "post");
})();

(() => {
  "use strict";

  const HASHTAGS = "#読書 #読書記録 #読書好きな人と繋がりたい #本 #book #bookstagram #読了 #本好き";
  const HISTORY_KEY = "book-scan-history";
  const HISTORY_LIMIT = 30;

  const readerEl = document.getElementById("reader");
  const startBtn = document.getElementById("start-scan-btn");
  const stopBtn = document.getElementById("stop-scan-btn");
  const scanStatus = document.getElementById("scan-status");
  const manualForm = document.getElementById("manual-form");
  const manualInput = document.getElementById("manual-isbn");
  const resultSection = document.getElementById("result-section");
  const bookInfoEl = document.getElementById("book-info");
  const postTextEl = document.getElementById("post-text");
  const copyBtn = document.getElementById("copy-btn");
  const copyStatus = document.getElementById("copy-status");
  const errorSection = document.getElementById("error-section");
  const errorMessageEl = document.getElementById("error-message");
  const historySection = document.getElementById("history-section");
  const historyList = document.getElementById("history-list");

  let scanner = null;
  let isScanning = false;

  function showError(message) {
    errorMessageEl.textContent = message;
    errorSection.hidden = false;
  }

  function clearError() {
    errorSection.hidden = true;
    errorMessageEl.textContent = "";
  }

  async function startScan() {
    clearError();
    if (typeof Html5Qrcode === "undefined") {
      showError("バーコード読み取りライブラリの読み込みに失敗しました。通信環境を確認してください。");
      return;
    }
    scanner = new Html5Qrcode("reader", {
      formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13],
      verbose: false,
    });
    try {
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 260, height: 140 } },
        onScanSuccess,
        () => {}
      );
      isScanning = true;
      startBtn.hidden = true;
      stopBtn.hidden = false;
      scanStatus.textContent = "本の裏表紙のバーコードを枠内に写してください";
    } catch (err) {
      showError("カメラを起動できませんでした。カメラの利用を許可しているかご確認ください。");
      console.error(err);
    }
  }

  async function stopScan(statusMessage) {
    if (scanner && isScanning) {
      try {
        await scanner.stop();
        scanner.clear();
      } catch (err) {
        console.error(err);
      }
    }
    isScanning = false;
    startBtn.hidden = false;
    stopBtn.hidden = true;
    scanStatus.textContent = statusMessage || "";
  }

  function onScanSuccess(decodedText) {
    const isbn = decodedText.replace(/[^0-9]/g, "");
    stopScan("読み取りました: " + isbn);
    lookupIsbn(isbn);
  }

  startBtn.addEventListener("click", startScan);
  stopBtn.addEventListener("click", () => stopScan(""));

  manualForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const isbn = manualInput.value.replace(/[^0-9]/g, "");
    if (isbn.length < 10) {
      showError("正しいISBN（10桁または13桁の数字）を入力してください。");
      return;
    }
    lookupIsbn(isbn);
  });

  async function lookupIsbn(isbn) {
    clearError();
    resultSection.hidden = true;
    scanStatus.textContent = "書誌情報を取得中...";
    try {
      const res = await fetch("https://api.openbd.jp/v1/get?isbn=" + encodeURIComponent(isbn));
      if (!res.ok) {
        throw new Error("HTTP " + res.status);
      }
      const data = await res.json();
      const entry = data && data[0];
      if (!entry) {
        showError("ISBN " + isbn + " の書誌情報が見つかりませんでした。");
        scanStatus.textContent = "";
        return;
      }
      const book = extractBookInfo(entry, isbn);
      renderBook(book);
      saveToHistory(book);
      scanStatus.textContent = "";
    } catch (err) {
      console.error(err);
      showError("書誌情報の取得に失敗しました。通信状況をご確認のうえ再度お試しください。");
      scanStatus.textContent = "";
    }
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
      cover: summary.cover || "",
      description,
    };
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

  function renderBook(book) {
    bookInfoEl.innerHTML = "";

    const coverWrap = document.createElement(book.cover ? "img" : "div");
    if (book.cover) {
      coverWrap.src = book.cover;
      coverWrap.alt = book.title;
      coverWrap.loading = "lazy";
    } else {
      coverWrap.className = "no-cover";
      coverWrap.textContent = "表紙画像なし";
    }
    bookInfoEl.appendChild(coverWrap);

    const dl = document.createElement("dl");
    dl.innerHTML =
      "<dt>タイトル</dt><dd>" + escapeHtml(book.title) + "</dd>" +
      "<dt>著者</dt><dd>" + escapeHtml(book.author || "-") + "</dd>" +
      "<dt>出版社</dt><dd>" + escapeHtml(book.publisher || "-") + "</dd>" +
      "<dt>ISBN</dt><dd>" + escapeHtml(book.isbn) + "</dd>";
    bookInfoEl.appendChild(dl);

    postTextEl.value = buildPostText(book);
    copyStatus.textContent = "";
    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

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
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
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
    if (history.length === 0) {
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

  renderHistory();
})();

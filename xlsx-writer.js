// 外部ライブラリを使わずに、1シートだけの Excel ファイル（.xlsx）を作る小さな部品。
// .xlsx の中身は「決まった名前の XML ファイルを ZIP でまとめたもの」なので、それを直接組み立てる。
(() => {
  "use strict";

  const enc = new TextEncoder();

  // ---------- ZIP（無圧縮）----------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  function zip(files) {
    const { time, date } = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;

    files.forEach(({ name, data }) => {
      const nameBytes = enc.encode(name);
      const body = typeof data === "string" ? enc.encode(data) : data;
      const crc = crc32(body);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true); // 展開に必要なバージョン
      local.setUint16(6, 0x0800, true); // ファイル名は UTF-8
      local.setUint16(8, 0, true); // 無圧縮
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, body.length, true);
      local.setUint32(22, body.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, body);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, body.length, true);
      cen.setUint32(24, body.length, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), nameBytes);

      offset += 30 + nameBytes.length + body.length;
    });

    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  // ---------- シートの XML ----------

  function esc(v) {
    return String(v)
      // XML で使えない制御文字を除く
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function colName(i) {
    let s = "";
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  function cellXml(value, ref, style) {
    const s = style ? ' s="' + style + '"' : "";
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "number" && isFinite(value)) return '<c r="' + ref + '"' + s + "><v>" + value + "</v></c>";
    return '<c r="' + ref + '" t="inlineStr"' + s + '><is><t xml:space="preserve">' + esc(value) + "</t></is></c>";
  }

  // columns: [{ header, width, type: "text" | "number" }], rows: 値の配列の配列
  function build({ sheetName, columns, rows }) {
    const lastCol = colName(columns.length - 1);
    const lastRow = rows.length + 1;

    const cols = columns
      .map((c, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + c.width + '" customWidth="1"/>')
      .join("");

    const headerRow =
      '<row r="1">' + columns.map((c, i) => cellXml(c.header, colName(i) + "1", 1)).join("") + "</row>";

    const bodyRows = rows
      .map((r, ri) => {
        const rn = ri + 2;
        const cells = r
          .map((v, ci) => {
            const t = columns[ci].type;
            let val = v;
            if (t === "number") {
              const n = Number(v);
              val = v === "" || v === null || v === undefined || !isFinite(n) ? v : n;
            } else if (v !== null && v !== undefined) {
              val = String(v); // ISBN なども文字として入れるので、数値表示に化けない
            }
            return cellXml(val, colName(ci) + rn, 2);
          })
          .join("");
        return '<row r="' + rn + '">' + cells + "</row>";
      })
      .join("");

    const sheet =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:' + lastCol + lastRow + '"/>' +
      // 1行目（見出し）を固定
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="18"/>' +
      "<cols>" + cols + "</cols>" +
      "<sheetData>" + headerRow + bodyRows + "</sheetData>" +
      // 見出しに絞り込みボタンを付ける
      '<autoFilter ref="A1:' + lastCol + lastRow + '"/>' +
      "</worksheet>";

    const styles =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/><family val="3"/><charset val="128"/></font>' +
      '<font><b/><sz val="11"/><name val="Yu Gothic"/><family val="3"/><charset val="128"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFF1E6D6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
      // 本文：折り返さず、上下中央に
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>' +
      "</cellXfs>" +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>";

    const workbook =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + esc(sheetName) + '" sheetId="1" r:id="rId1"/></sheets>' +
      '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">' +
      "'" + esc(sheetName).replace(/'/g, "''") + "'!$A$1:$" + lastCol + "$" + lastRow +
      "</definedName></definedNames>" +
      "</workbook>";

    return zip([
      {
        name: "[Content_Types].xml",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          "</Types>",
      },
      {
        name: "_rels/.rels",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          "</Relationships>",
      },
      { name: "xl/workbook.xml", data: workbook },
      {
        name: "xl/_rels/workbook.xml.rels",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          "</Relationships>",
      },
      { name: "xl/worksheets/sheet1.xml", data: sheet },
      { name: "xl/styles.xml", data: styles },
    ]);
  }

  window.XlsxWriter = { build };
})();

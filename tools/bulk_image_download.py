#!/usr/bin/env python3
"""画像URLの一覧ファイルから、画像をまとめて保存するスクリプト。

使い方:
    python3 bulk_image_download.py urls.txt 保存先フォルダ [--wait 1.0]

urls.txt には画像ファイルのURLを1行に1つずつ書きます（# で始まる行は無視）。
自分の素材やフリー素材など、保存してよい画像にだけ使ってください。
"""
import argparse
import os
import sys
import time
import urllib.parse
import urllib.request

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}


def read_urls(path):
    with open(path, encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip() and not line.startswith("#")]


def file_name(url, index):
    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
    if ext not in IMAGE_EXTS:
        ext = ".jpg"
    return f"{index:03d}{ext}"


def main():
    parser = argparse.ArgumentParser(description="画像URL一覧から一括ダウンロード")
    parser.add_argument("url_list", help="画像URLを1行ずつ書いたテキストファイル")
    parser.add_argument("out_dir", help="保存先フォルダ")
    parser.add_argument("--wait", type=float, default=1.0, help="1枚ごとの待ち時間（秒）")
    args = parser.parse_args()

    urls = read_urls(args.url_list)
    os.makedirs(args.out_dir, exist_ok=True)
    ok = 0
    for i, url in enumerate(urls, start=1):
        dest = os.path.join(args.out_dir, file_name(url, i))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "bulk-image-download/1.0"})
            with urllib.request.urlopen(req, timeout=30) as res:
                if not res.headers.get("Content-Type", "").startswith("image/"):
                    print(f"[skip] 画像ではありません: {url}")
                    continue
                with open(dest, "wb") as f:
                    f.write(res.read())
            ok += 1
            print(f"[ok] {dest}")
        except Exception as e:
            print(f"[error] {url}: {e}", file=sys.stderr)
        time.sleep(args.wait)
    print(f"完了: {ok}/{len(urls)} 枚")


if __name__ == "__main__":
    main()

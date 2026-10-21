#!/usr/bin/env python3
"""画像URLの一覧ファイルから、画像をまとめて保存するスクリプト。

使い方:
    python3 bulk_image_download.py urls.txt 保存先フォルダ [--wait 1.0]
    python3 bulk_image_download.py          （引数なし：その場でURLを貼り付けて保存）

urls.txt には画像ファイルのURLを1行に1つずつ書きます（# で始まる行は無視）。
保存先を省略すると、Android なら Download/images、それ以外は images に保存します。
同じURL・同じ中身の画像は保存を飛ばし、既存のファイルは上書きしません。
自分の素材やフリー素材など、保存してよい画像にだけ使ってください。
"""
import argparse
import hashlib
import os
import sys
import time
import urllib.parse
import urllib.request

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}
ANDROID_DOWNLOAD = "/sdcard/Download"


def default_out_dir():
    if os.path.isdir(ANDROID_DOWNLOAD):
        return os.path.join(ANDROID_DOWNLOAD, "images")
    return "images"


def read_urls(path):
    with open(path, encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip() and not line.startswith("#")]


def input_urls():
    print("画像のURLを1行に1つずつ貼り付けてください。何も入力せずEnterで開始します。")
    urls = []
    while True:
        line = input("> ").strip()
        if not line:
            return urls
        if not line.startswith("#"):
            urls.append(line)


def unique(urls):
    seen = set()
    return [u for u in urls if not (u in seen or seen.add(u))]


def existing_hashes(out_dir):
    hashes = set()
    for name in os.listdir(out_dir):
        path = os.path.join(out_dir, name)
        if os.path.isfile(path):
            with open(path, "rb") as f:
                hashes.add(hashlib.sha256(f.read()).hexdigest())
    return hashes


def free_path(out_dir, url, index):
    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
    if ext not in IMAGE_EXTS:
        ext = ".jpg"
    while True:
        path = os.path.join(out_dir, f"{index:03d}{ext}")
        if not os.path.exists(path):
            return path, index
        index += 1


def main():
    parser = argparse.ArgumentParser(description="画像URL一覧から一括ダウンロード")
    parser.add_argument("url_list", nargs="?", help="画像URLを1行ずつ書いたテキストファイル（省略するとその場で入力）")
    parser.add_argument("out_dir", nargs="?", default=default_out_dir(), help="保存先フォルダ")
    parser.add_argument("--wait", type=float, default=1.0, help="1枚ごとの待ち時間（秒）")
    args = parser.parse_args()

    urls = unique(read_urls(args.url_list) if args.url_list else input_urls())
    os.makedirs(args.out_dir, exist_ok=True)
    hashes = existing_hashes(args.out_dir)
    print(f"保存先: {os.path.abspath(args.out_dir)}")
    ok = 0
    index = 1
    total = len(urls)
    for n, url in enumerate(urls, start=1):
        tag = f"[{n}/{total}]"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "bulk-image-download/1.0"})
            with urllib.request.urlopen(req, timeout=30) as res:
                if not res.headers.get("Content-Type", "").startswith("image/"):
                    print(f"{tag} skip 画像ではありません: {url}")
                    continue
                data = res.read()
            digest = hashlib.sha256(data).hexdigest()
            if digest in hashes:
                print(f"{tag} skip 保存済みの画像です: {url}")
                continue
            dest, index = free_path(args.out_dir, url, index)
            with open(dest, "wb") as f:
                f.write(data)
            hashes.add(digest)
            ok += 1
            print(f"{tag} ok {os.path.basename(dest)}")
        except Exception as e:
            print(f"{tag} error {url}: {e}", file=sys.stderr)
        finally:
            if n < total:
                time.sleep(args.wait)
    print(f"完了: {ok}/{total} 枚")


if __name__ == "__main__":
    main()

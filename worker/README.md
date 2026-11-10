# 価格中継プログラム (Cloudflare Worker)

ブラウザから Yahoo!ショッピング商品検索API(v3)を直接呼べない(CORS非対応)ため、代わりに問い合わせて結果を返す。

- 公開URL: https://bookworm-price.beards-hows-2x.workers.dev/?isbn=9784167158057
- 配置: Cloudflare の Worker `bookworm-price`。本番用の枝 `claude/book-library-app-qwyxgd` の `worker/` を Git 連携で自動デプロイする。
- アプリケーションID: Cloudflare のシークレット `YAHOO_APPID` に保存(コードには書かない)。
- 使えるのは `https://dustbox-beep.github.io` からだけ(ブラウザ以外で直接開くのは確認用に許可)。
- 返す内容: 在庫ありの出品を安い順に `{price, condition(used/new), shop, group(ブックオフ/ネットオフ/空), freeShipping, url}`。同じISBNは1時間キャッシュ。

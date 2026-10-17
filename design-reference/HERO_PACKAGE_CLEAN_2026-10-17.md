# 2026-10-17 ヒーローのパッケージ修正

「チップスなどはいじらず、パッケージだけ変えて」という指示に対応。
袋の過度なしわと印刷の歪みを減らし、元の印刷内容・薄い袋の形・位置・画角を維持した。

- 基準画像：2026-10-15に採用された `lp-real-surface-color-v4-20261014/01-hero-real-surfaces.png`。
- 内蔵 `image_gen` でパッケージを整え、元画像の袋の輪郭の内側だけをマスク合成。
- チップスの材質・色・形、手、皿、背景、接地影は基準画像を使用。PNGマスターでは袋のマスク外の変更画素数が0であることを検証。
- パッケージの印刷・材質の参照：`assets/package-cutout-green-v3.png` と実物写真の `lp-real-photo-review-20261013/cutouts/pouch-front.png`。
- 配信画像：`assets/hero-package-clean-20261017.webp`（1536×1024、品質94）。SNS・構造化データ用：`assets/hero-package-clean-20261017.jpg`（1200×800）。通常の配信用圧縮以外の全体加工はなし。
- ヒーロー画像と先読み、SNS・構造化データの画像参照のみ更新。ほかの3枚の採用画像、CSS、JavaScript、LP文言とレイアウトは変更なし。
- 320 / 390 / 768 / 1440 / 1920 / 3440 pxで画像読込、横はみ出し、主要要素の矩形を比較。レイアウト差異と横はみ出しはいずれも0。390 / 1440 / 3440 pxの画面記録で視覚確認。

作業マスター、マスク、生成原本、最終プロンプト、画素検証記録：
`C:/Users/菊地/Documents/ChatGPT/BODY-MAKE CHIPS/hero-package-clean-20261017/`

表示検証記録：
`C:/Users/菊地/Documents/ChatGPT/BODY-MAKE CHIPS/previews/hero-package-20261017/`

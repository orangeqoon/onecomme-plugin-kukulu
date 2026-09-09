# kukuluLIVE コメント連携プラグイン for わんコメ

[わんコメ（OneComme）](https://onecomme.com/) に、[kukuluLIVE](https://live.erinn.biz/) のコメントを取り込むプラグインです。

コメント取得に加え、**お絵描きコメントの大画面表示＆クリック拡大**、OBS等の配信ソフトから接続された際の**自動枠取得**および**自動公開配信（ステータス2化）**にも対応しています。

---

## 主な機能

- **リアルタイムコメント取得**: kukuluLIVE公式コメントAPIを利用して、通常コメント・配信者コメントをわんコメに自動連携。
- **お絵描き・画像コメント大画面表示**: kukuluLIVE特有の「お絵描きコメント（visualchat）」や画像コメントを、通常の小さなサムネイルではなく**大サイズ（最大幅650px×高さ520px）**で迫力表示！白キャンバス風カードと影付きスタイルで綺麗にレンダリングされます。
- **クリックで原寸大ポップアップ**: 表示された絵をクリックすると、ブラウザで原寸大の高解像度画像が直接開きます。
- **表示サイズの自由なカスタマイズ**: `config.json` の設定値（`imageMaxWidth`, `imageMaxHeight`）で、お好みのサイズに自由に変更可能。
- **配信枠の自動検出**: わんコメ側の配信枠一覧から「Kukulu」「kuku.lu」「erinn.biz」を含む枠を自動で検索して紐付けます（面倒なUUIDの入力は不要です）。
- **自動枠取得（オプション）**: 枠がまだ取られていない場合、API経由で自動的に配信ポートを取得します。
- **自動公開化（オプション）**: OBS等のプッシュ配信を検知し、「準備中（status: 1）」から自動で「配信中（status: 2）」へ切り替えます。

---

## 導入手順

### 1. ダウンロードと配置
1. 本リポジトリ右上の **「Code」→「Download ZIP」**（または Releases）からZIPファイルをダウンロードし、解凍します。
2. わんコメを開き、左上の **メニュー「≡」→「連携」→「プラグイン」** を開きます。
3. プラグイン一覧画面の **「フォルダを開く」** ボタンをクリックします。
   （エクスプローラーで `%APPDATA%\onecomme\plugins` が開きます）
4. 解凍したフォルダ（フォルダ名を `kukulu-live` 等にリネーム推奨）をプラグインフォルダ内に配置します。

フォルダ構成のイメージ:
```text
plugins/
  kukulu-live/
    plugin.js
    config.sample.json
    README.md
    LICENSE
```

### 2. わんコメ側で枠を追加
1. わんコメの左側「視聴者」または「配信」一覧の **「＋」** ボタンを押して新規枠を作成します。
2. 枠の名前を **`#Kukulu`**（または `Kukulu`）にします。
3. URLには自分のkukuluLIVE固定配信ページURL（例: `https://live.erinn.biz/v/ユーザーID`）または `https://live.erinn.biz/` を入力して保存します。
   （※単に `https://kuku.lu/` のみを入れると短縮URLサービスページが開いてしまうため、kukuluLIVEの `https://live.erinn.biz/v/ユーザーID` の指定を推奨します）

### 3. APIキーの設定
1. プラグインフォルダ内の `config.sample.json` をコピーして **`config.json`** にリネームします。
   （初回起動時に自動生成される `config.json` をそのまま編集しても構いません）
2. テキストエディタ（メモ帳やVSCode等）で `config.json` を開きます。
3. kukuluLIVEのAPIキーを入力します。

```json
{
  "apikey": "あなたのkukuluLIVE APIキー",
  "serviceId": "",
  "intervalMs": 2000,
  "autoPublish": true,
  "autoGetPort": true,
  "imageMaxWidth": 650,
  "imageMaxHeight": 520
}
```

#### kukuluLIVE APIキーの確認方法:
1. kukuluLIVEにログインした状態で [API仕様・設定ページ](https://live.erinn.biz/manual.php?tab=api) を開きます。
2. ページ内に表示されている `apikey` をコピーして設定してください。

### 4. 有効化
わんコメのプラグイン画面で **「再読み込み」** を押すか、わんコメを再起動すると自動で接続が開始されます。

---

## 設定項目一覧 (`config.json`)

| キー | 型 | 初期値 | 説明 |
| :--- | :--- | :--- | :--- |
| `apikey` | 文字列 | 必須 | kukuluLIVEのAPIキー |
| `serviceId` | 文字列 | `""` | わんコメの枠ID。**空欄のままでOK**（枠名やURLから自動検出されます） |
| `intervalMs` | 数値 | `2000` | コメント取得間隔（ミリ秒）。推奨2000（2秒） |
| `autoPublish` | 真偽値 | `true` | OBS接続時に「準備中」から自動で「配信中」に切り替えるかどうか |
| `autoGetPort` | 真偽値 | `true` | 配信枠が無い場合に自動で枠を取得するかどうか |
| `imageMaxWidth` | 数値 | `650` | お絵描き・画像の最大横幅（ピクセル）。お好みの大きさに変更可能 |
| `imageMaxHeight` | 数値 | `520` | お絵描き・画像の最大高さ（ピクセル）。お好みの大きさに変更可能 |

---

## 免責事項・ライセンス

本プラグインは個人が作成した非公式ツールです。kukuluLIVEおよびわんコメ公式とは直接の関係はありません。各サービスの利用規約に従ってご利用ください。

MIT License (c) 2026 orangeqoon

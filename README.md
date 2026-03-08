# scra

DuckDuckGoによるWeb検索と[Readability.js](https://github.com/mozilla/readability)を使ったWebフェッチを行うミニマムなMCPサーバー

## Usage
```bash
git clone https://github.com/rxon/scra.git
bun install
```

LMStudioなどでの設定

```json
{
  "mcpServers": {
    "scra": {
      "command": "bun",
      "args": [
        "run",
        "/path/to/scra/index.ts"
      ]
    }
  }
}
```

## Tools
- `search` キーワードでDuckDuckGoを検索し、タイトル・URL・スニペットを番号付きで返す。 
- `fetch` URLを指定してページ本文をMarkdown形式（# タイトル + 本文）で返す。

## License
WTFPL
# markdown-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Scynun/markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Scynun/markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer, byte-identical to [marked](https://github.com/markedjs/marked) 18.1.3 with default options (GFM on, breaks off). Built for [make.fun](https://make.fun)'s ["Make Markdown rendering faster"](https://make.fun/bounty/markdown-render-speed-02) bounty.

## Run

```sh
node main.ts
```

Reads `/input/cases.json`, renders each case with `parse()`, writes `/output/html.json`.

## Files

- `parse.js` — the renderer (dependency-free ES module, exports `parse(markdown)`)
- `main.ts` — the harness driver

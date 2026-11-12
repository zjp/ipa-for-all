# IPA for All

Wikipedia explains each symbol of an English pronunciation when you hover over it.
For every other language, when you hover over a symbol it just links to the IPA
key for that language. This userscript gives every language the per-symbol hover.

For example, hover `ʁ` in a French transcription such as `[paʁi]` and you see: 
voiced uvular fricative, like Scottish English lo**ch** but voiced, e.g. 
**r**ega**r**der.

(This is one hundred percent vibe-coded.)

## Install

1. Install a userscript manager such as
   [Violentmonkey](https://violentmonkey.github.io/) (Firefox, Chrome, Edge) or
   Tampermonkey.
2. Open
   [`ipa-for-all.user.js`](https://github.com/zjp/ipa-for-all/raw/main/ipa-for-all.user.js)
   and confirm the install prompt.
3. Reload any English Wikipedia article with a foreign-language pronunciation
   (try [Beijing](https://en.wikipedia.org/wiki/Beijing)) and hover a symbol.

The script declares its update URL, so the manager picks up new versions from
this repository.

**No extension:** if you have a Wikipedia account, paste the contents of
`ipa-for-all.user.js` into
[Special:MyPage/common.js](https://en.wikipedia.org/wiki/Special:MyPage/common.js)
instead.

## How it works

1. Finds transcriptions that link to a key page (`Help:IPA/French`, `Help:IPA/Mandarin`, …).
2. Fetches that key once through the MediaWiki API and reads its tables into a
   symbol → {sound name, examples, English approximation} map. Cached in
   `localStorage` for a week.
3. Splits the transcription by longest match against the key, so `tɕʰ`, `ɑ̃` and
   `aɪ` stay whole, and diacritics and tone marks are explained alongside the
   sound they sit on.
4. Symbols a language's key does not list fall back to the general `Help:IPA` chart.

Nothing is hard-coded per language: whatever the key page says is what the
tooltip says, and new or edited keys are picked up automatically.

## Limits

- English Wikipedia only in practice: other editions link their transcriptions
  to differently structured key pages.
- A few keys have no symbol column to read (Khmer is organised by script, not by
  IPA), so those transcriptions only get the general fallback.
- Hover only; there is no touch interaction.

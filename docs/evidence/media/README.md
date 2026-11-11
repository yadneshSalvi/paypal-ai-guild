# Exhibition and media evidence

The public sample at `/exhibitions/harbor-street` is an actual document renderer with twelve locally served archival photographs, eight authored editorial families and six complete locale modules. Its museum and harbor map are fictional. Its document provenance is `sample`, its accepted-artifact list is empty, and it makes no payment or commissioned-acceptance claim.

The offline file at `/museum/harbor-street-offline.html` contains the photographs and font bytes within one HTML file. It carries all six languages, the original source notes, full-frame source views, image fingerprints and font licences. Its language controls, chapter links, harbor map, high contrast, reading width, spacious typography and kiosk control are authored code; exhibition text cannot introduce scripts or arbitrary HTML. The live viewer's export button builds the same format from the supplied document rather than fetching a fake completion state. A JSON document export is also available.

## Measured files

| Evidence | Meaning |
| --- | --- |
| `verification.json` | Actual recomputed hashes, full pixel decoding of 36 images, JPEG end markers and twelve primary MARCXML hashes |
| `offline-build.json` | Actual portable HTML byte count and SHA-256; embedded image/font counts; generated controller compilation status |
| `language-status.json` | Per-locale authored key counts, source descriptions, direction, review and audio status |
| `browser-review.json` | The integration owner's reported browser observations and explicitly untested interactions |
| `contact-sheet.webp` | The twelve real local photographs used to review descriptions against image content |
| `arabic-phone.png` | An actual development screenshot captured by the integration owner at 390×844; it retains the development indicator |

Run `node --import tsx --test src/exhibition/museum.test.ts` for the eight deterministic source/export/safety tests. Run `node fixtures/museum/verify-media.mjs` to reproduce the pixel/file report and `node --import tsx fixtures/museum/build-offline.mjs` to rebuild the standalone file. The current run passes eight tests and verifies twelve source records, 36 decoded images and twelve metadata snapshots. These checks do not establish human translation quality, screen-reader usability or real-audio quality.

## Primary photograph records

Each is from the Library of Congress Detroit Publishing Company Collection. The records identify Detroit Publishing Co. as publisher, sometimes also copyright claimant; an individual photographer is not named. Their exact native contributor roles and all native notes are in the manifest and source drawer. The rights advisory for each is “No known restrictions on publication.”

| Local digital image | Primary record | Native catalogue date |
| --- | --- | --- |
| `4a22773` | [Steamers at pier, Port Huron, Mich.](https://www.loc.gov/item/2016800528/) | `c1908.` |
| `4a16590` | [Steamer, Michigan Trans. Co](https://www.loc.gov/item/2016807156/) | `[between 1890 and 1905]` |
| `4a21996` | [Transfer steamer Detroit](https://www.loc.gov/item/2016813544/) | `[between 1900 and 1905]` |
| `4a20344` | [Tashmoo and Idlewild at wharves, Detroit](https://www.loc.gov/item/2016811564/) | `[ca. 1901]` |
| `4a16836` | [Str. Eastern States](https://www.loc.gov/item/2016807373/) | `[between 1901 and 1910]` |
| `4a20920` | [Steamer City of Cleveland, broadside](https://www.loc.gov/item/2016812640/) | `[1907]` |
| `4a25770` | [Western States and City of Mackinac](https://www.loc.gov/item/2016816128/) | `[between 1900 and 1920]` |
| `4a25819` | [Lighthouse on island](https://www.loc.gov/item/2016816172/) | `c1896.` |
| `4a12861` | [Handling a cargo from the fishing banks, Gloucester](https://www.loc.gov/item/2016805473/) | `c[1905]` |
| `4a17226` | [Unloading fish at T wharf, Boston](https://www.loc.gov/item/2016809156/) | `[between 1900 and 1910]` |
| `4a10172` | [N.Y. harbor from the Battery](https://www.loc.gov/item/2016802412/) | `[c1908]` |
| `4a25811` | [Steamer at dock](https://www.loc.gov/item/2016816165/) | `[between 1900 and 1920]` |

The archive's complete primary metadata snapshots are at `fixtures/museum/records/{itemId}.marcxml`. `SourceAsset.contentHash` hashes the actual local WebP. Original JPEG, downloaded TIFF and native MARCXML hashes are separate measurements. No archive-issued checksum, invented rights licence or identified photographer is asserted. Two truncated sentences in the New York record remain truncated exactly as in its native MARCXML.

## Review status and limits

All six languages are AI-authored drafts and remain **not fluent-reviewed**. Every locale has translated chapter text, captions, proposed transcripts, image descriptions, source interpretation and interface labels. Native archive metadata and legal font licences remain in their original language with appropriate language/direction annotations. The presence and structural completeness of text do not establish its semantic accuracy.

There are **zero attached audio recordings**. The listening room is explicitly transcript-only and does not impersonate an oral-history witness. Native audio controls, actual playback rate, cue seeking and transcript following are implemented for documents that provide a real recording. The conditional-rendering unit fixture is synthetic test data, not an exhibition audio artifact.

The integration owner observed the English desktop layout and Arabic at 390×844, verified the Arabic container's language and direction, opened reading settings with focus on Close, closed it with Escape and saw high-contrast/spacious settings persist when reopened. A roughly one-pixel phone overflow was observed; a containment patch was applied afterward and still needs remeasurement. Complete map/source/download/kiosk keyboard traversal, 768-pixel browser coverage, screen-reader review, contrast automation and opening the portable file offline remain explicit integration checks. `offline-build.json` keeps `browserVerified: false` until that last check is actually performed.

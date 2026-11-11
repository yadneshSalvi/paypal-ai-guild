# Harbor Street exhibition fixture

Harbor Street Maritime Museum is fictional. The twelve photographs are real images from the Library of Congress Detroit Publishing Company Collection. Their real places, uncertain dates, titles and contributor roles remain attached to them. No sample artifact is represented as accepted or paid.

The exhibition works without a database, account, model key or payment configuration. From the Guild repository root, install its pinned dependencies and run `npm run dev`, then open `http://localhost:4101/exhibitions/harbor-street`. Add `?lang=ar#listening-room`, for example, to select a language and chapter. The committed files in `public/museum/` are sufficient for normal use; source downloads are not required at startup.

The eight layouts are `cover`, `full_bleed`, `split`, `collection_grid`, `comparison`, `audio`, `timeline` and `credits`. The client boundary is `ExhibitionViewer({ document })` from `src/components/exhibition/exhibition-viewer.tsx`. `src/exhibition/museum.ts` exports `museumExhibition` and `museumSources` using the shared `ExhibitionDocument` and `SourceAsset` contracts. The same renderer accepts a correctly validated document assembled from real accepted artifacts; the public Harbor Street route deliberately supplies the sample.

## Files and provenance

- `catalogue.json`: authored collection descriptions plus exact native metadata read from primary MARCXML.
- `records/*.marcxml`: original Library of Congress metadata responses, retained byte for byte.
- `records/4a*.json`: descriptive metadata, actual resolved download URLs, dimensions, treatment and measured file hashes.
- `media-manifest.json`: the combined twelve-source manifest, also published as `/museum/media-manifest.json`.
- `glossary.json`: draft terminology across all six languages. It is not a fluent-review artifact.
- `public/museum/images/`: full-frame, 2200-pixel-wide WebP derivatives of downloaded archival TIFFs.
- `public/museum/thumbnails/`: full-frame 640-pixel thumbnails.
- `public/museum/originals/`: complete archive JPEG renditions. Boston image `4a17226` uses the archive's medium `r.jpg` rendition; its exhibition WebP still comes from the full-resolution TIFF.
- `public/museum/fonts/`: three locally bundled font subsets and their original SIL Open Font License texts.
- `public/museum/harbor-street-offline.html`: a generated standalone edition with all twelve photographs, three embedded fonts, six languages, native source notes, map and chapter navigation, reading controls and kiosk mode.

`SourceAsset.contentHash` is SHA-256 of the local WebP at `imagePath`. `originalHash` hashes the actual downloaded JPEG; `masterHash` hashes the actual downloaded TIFF; `marcxmlHash` hashes the primary metadata response. These are measured file hashes, not checksums claimed to have been issued by the archive. Large TIFF masters are converted, verified and removed; the manifest retains their source URLs, hashes and dimensions.

All native MARC `500` and `541` notes are preserved. Two panorama notes in the New York record end mid-sentence in the archive's own MARCXML; those incomplete sentences are retained without invented endings. The archive's later attributed catalogue summaries remain separate from the exhibition's interpretation. The publisher is not silently promoted to an identified photographer.

The item-level rights advisory is **“No known restrictions on publication.”** The wording is preserved, with a link to the archive's rights guidance. No Creative Commons licence is invented. Credit: Library of Congress, Prints & Photographs Division, Detroit Publishing Company Collection. The collection's primary description is [available from the Library of Congress](https://www.loc.gov/pictures/collection/det/).

## Reproduce the evidence

Run these commands from the Guild repository root:

```sh
node --import tsx --test src/exhibition/museum.test.ts
node fixtures/museum/verify-media.mjs
node --import tsx fixtures/museum/build-offline.mjs
npm run typecheck
```

To refresh the archive inputs, first run `python3 fixtures/museum/fetch-records.py`, then `node fixtures/museum/prepare-media.mjs`, followed by the checks above. Both download scripts use only public primary archive endpoints. Existing image files are reused only when their recorded hashes match. Interrupted transfers do not become verified assets. Refreshing metadata changes the fixture document, so review the resulting diff before treating it as a new evidence baseline.

The eight tests cover source/file integrity, source references, all eight layout families, six locale key sets and non-placeholder text, truthful provenance, export completeness, injection escaping, bounded URLs/palettes/crops, and conditional audio rendering. The pixel verifier decodes all 36 committed image files and checks all twelve primary metadata snapshots. Reports live in `docs/evidence/media/`.

English, Portuguese, Spanish, French, Japanese and Arabic are complete AI-authored drafts. All six `fluentReviewed` flags are false; no reviewer or review date is fabricated. No narration audio is attached. The listening room therefore displays a translated proposed reading and an explicit transcript-only disclosure. Native audio controls and synchronized cue seeking activate only when a document supplies an actual recording. Japanese uses a platform serif fallback; the independent Arabic typeface is embedded locally and in the offline edition.

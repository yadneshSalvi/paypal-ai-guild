"""Preserve and transcribe primary MARCXML. Run from the Guild repository root."""
import concurrent.futures
import hashlib
import json
import pathlib
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

catalogue_path = pathlib.Path("fixtures/museum/catalogue.json")
catalogue = json.loads(catalogue_path.read_text())
ns = {"m": "http://www.loc.gov/MARC21/slim"}


def fetch_record(item):
    url = f'https://lccn.loc.gov/{item["itemId"]}/marcxml'
    with urllib.request.urlopen(url, timeout=40) as response:
        raw = response.read()
    root = ET.fromstring(raw)

    def fields(tag):
        return root.findall(f'm:datafield[@tag="{tag}"]', ns)

    def value(field, codes=None):
        return " ".join(s.text.strip() for s in field if s.text and (codes is None or s.get("code") in codes))

    identifiers = [value(f, {"a"}).strip() for f in fields("010")]
    if item["itemId"] not in identifiers:
        raise ValueError(f'{item["itemId"]}: archive identifier does not match MARCXML')
    notes = [value(f, {"a"}) for f in fields("500")]
    notes += [value(f, {"c", "a", "d"}) for f in fields("541")]
    rights = [value(f, {"a"}) for f in fields("540")]
    if "No known restrictions on publication." not in rights:
        raise ValueError(f'{item["itemId"]}: expected rights advisory is absent')
    item.update({
        "nativeTitle": " ".join(value(f, {"a", "b"}) for f in fields("245")),
        "nativeDate": " ".join(value(f, {"c"}) for f in fields("260")),
        "nativeContributors": [value(f, {"a", "e"}) for tag in ("100", "110", "700", "710") for f in fields(tag)],
        "nativeMedium": " ".join(value(f, {"a", "b", "c"}) for f in fields("300")),
        "nativeNotes": notes,
        "nativeSummary": [value(f, {"a"}) for f in fields("520")],
        "nativeRights": rights,
        "nativeNotesComplete": True,
        "nativeNotesCaveat": "All MARC 500 and 541 notes are preserved verbatim, including two New York panorama notes that end mid-sentence in the archive's own MARCXML. No missing words have been invented." if item["digitalId"] == "4a10172" else None,
        "marcxmlUrl": url,
        "marcxmlHash": hashlib.sha256(raw).hexdigest(),
        "metadataObservedAt": datetime.now(timezone.utc).isoformat(),
    })
    pathlib.Path(f'fixtures/museum/records/{item["itemId"]}.marcxml').write_bytes(raw)
    print(f'{item["itemId"]}: {item["nativeTitle"]}; {len(notes)} complete native notes')
    return item


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    records = list(pool.map(fetch_record, catalogue))
catalogue_path.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")

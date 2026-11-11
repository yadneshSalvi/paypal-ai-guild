import manifest from "../../fixtures/museum/media-manifest.json";

export interface MuseumArchiveRecord {
  id: string; digitalId: string; itemId: string; nativeTitle?: string; nativeDate?: string;
  nativeContributors?: string[]; nativeNotes?: string[]; nativeSummary?: string[]; nativeNotesCaveat?: string | null;
  marcxmlUrl?: string; marcxmlHash?: string; medium: string; creditLine: string;
  originalPath: string; originalHash: string; originalUrl: string; masterUrl: string; masterHash: string;
  imagePath: string; thumbnailPath: string; dimensions: { width: number; height: number };
  treatment: string; metadataMethod: string;
}

const archiveRecords = new Map<string, MuseumArchiveRecord>((manifest.records as MuseumArchiveRecord[]).map((record) => [record.id, record]));
export function museumArchiveRecord(id: string): MuseumArchiveRecord | undefined { return archiveRecords.get(id); }

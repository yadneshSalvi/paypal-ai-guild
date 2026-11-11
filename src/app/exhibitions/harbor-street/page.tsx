import type { Metadata } from "next";
import { ExhibitionViewer } from "@/components/exhibition/exhibition-viewer";
import { museumExhibition } from "@/exhibition/museum";

export const metadata: Metadata = {
  title: "Between water & work · Harbor Street",
  description: "Twelve real Library of Congress photographs in a clearly labeled fictional museum exhibition. Explore eight chapters in six languages, with original source notes and an offline edition.",
};

export default function HarborStreetExhibition() { return <ExhibitionViewer document={museumExhibition} />; }

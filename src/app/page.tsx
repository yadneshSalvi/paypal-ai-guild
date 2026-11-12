import { Studio } from "@/components/studio/studio";
import { redirect } from "next/navigation";
export default async function Home({ searchParams }: { searchParams: Promise<{ view?: string | string[]; commission?: string | string[] }> }) {
  const query = await searchParams;
  if (query.view === "market") redirect(`/market${typeof query.commission === "string" ? `?commission=${encodeURIComponent(query.commission)}` : ""}`);
  return <Studio/>;
}

import { paymentReturnPage } from "@/server/payments/return-page";
export const dynamic = "force-dynamic";
export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) { return paymentReturnPage(searchParams, true); }

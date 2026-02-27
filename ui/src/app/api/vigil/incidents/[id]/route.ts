import { NextResponse } from "next/server";
import client from "@/lib/elastic-client";
import { mapIncident } from "../route";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await client.search({
      index: "vigil-incidents",
      size: 1,
      query: { term: { "incident_id": id } },
    });
    if (result.hits.hits.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(mapIncident(result.hits.hits[0] as Record<string, unknown>));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

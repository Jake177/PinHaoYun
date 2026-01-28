import { NextRequest, NextResponse } from "next/server";

const MAPBOX_TOKEN =
  process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

type GeoResult = {
  label: string;
  address: string;
  lat: number;
  lon: number;
  city?: string;
  region?: string;
  country?: string;
};

const extractContext = (feature: any, prefix: string) =>
  feature?.context?.find((item: any) => String(item.id || "").startsWith(prefix))
    ?.text;

export async function GET(request: NextRequest) {
  try {
    if (!MAPBOX_TOKEN) {
      return NextResponse.json(
        { error: "Missing Mapbox token" },
        { status: 500 },
      );
    }

    const query = request.nextUrl.searchParams.get("query")?.trim();
    if (!query) {
      return NextResponse.json({ error: "Missing query" }, { status: 400 });
    }

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
      query,
    )}.json?access_token=${MAPBOX_TOKEN}&autocomplete=true&limit=6&language=en&types=address,place,locality,neighborhood`;

    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) {
      return NextResponse.json(
        { error: "Failed to fetch geocoding results" },
        { status: 502 },
      );
    }

    const data = (await resp.json()) as { features?: any[] };
    const results: GeoResult[] = (data.features || [])
      .map((feature) => {
        const [lon, lat] = feature.center || [];
        if (typeof lat !== "number" || typeof lon !== "number") return null;
        const city =
          extractContext(feature, "place") || extractContext(feature, "locality");
        const region = extractContext(feature, "region");
        const country = extractContext(feature, "country");
        return {
          label: feature.place_name || feature.text || query,
          address: feature.place_name || feature.text || query,
          lat,
          lon,
          city,
          region,
          country,
        };
      })
      .filter(Boolean) as GeoResult[];

    return NextResponse.json({ results });
  } catch (error: any) {
    console.error("[geo/search] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to search location" },
      { status: 500 },
    );
  }
}

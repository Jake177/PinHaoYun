import { NextRequest, NextResponse } from "next/server";

const MAPBOX_TOKEN =
  process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

type ReverseResult = {
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

    const lat = Number(request.nextUrl.searchParams.get("lat"));
    const lon = Number(request.nextUrl.searchParams.get("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
    }

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?access_token=${MAPBOX_TOKEN}&limit=1&language=zh-Hans&types=address,place,locality,neighborhood`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) {
      return NextResponse.json(
        { error: "Failed to fetch reverse geocoding" },
        { status: 502 },
      );
    }

    const data = (await resp.json()) as { features?: any[] };
    const feature = data.features?.[0];
    if (!feature) {
      return NextResponse.json({ error: "No address found" }, { status: 404 });
    }

    const city =
      extractContext(feature, "place") || extractContext(feature, "locality");
    const region = extractContext(feature, "region");
    const country = extractContext(feature, "country");

    const result: ReverseResult = {
      address: feature.place_name || feature.text || "",
      lat,
      lon,
      city,
      region,
      country,
    };

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("[geo/reverse] error", error);
    return NextResponse.json(
      { error: error?.message || "Failed to reverse geocode" },
      { status: 500 },
    );
  }
}

import type { LibraryMediaItem } from "@/app/lib/mediaLibrary";

export type MediaTypeFilter = "VIDEO" | "PHOTO";

export type LibraryFilterOptions = {
  query?: string | null;
  mediaType?: MediaTypeFilter | null;
  favorite?: boolean | null;
  datePrefix?: string | null;
};

export type MonthFacet = {
  value: string;
  count: number;
};

export type YearFacet = {
  value: string;
  count: number;
};

export function normaliseMediaTypeFilter(
  value?: string | null,
): MediaTypeFilter | null {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized === "VIDEO" || normalized === "PHOTO" ? normalized : null;
}

export function normaliseFavoriteFilter(
  value?: string | null,
): boolean | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

const searchableText = (item: LibraryMediaItem): string =>
  [
    item.originalName,
    item.captureAddress,
    item.captureCity,
    item.captureRegion,
    item.captureCountry,
    item.deviceMake,
    item.deviceModel,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .toLowerCase();

export function mediaMatchesLibraryFilters(
  item: LibraryMediaItem,
  filters: LibraryFilterOptions,
): boolean {
  if (filters.mediaType && item.type !== filters.mediaType) return false;

  if (
    filters.favorite !== null &&
    filters.favorite !== undefined &&
    Boolean(item.isFavorite) !== filters.favorite
  ) {
    return false;
  }

  if (filters.datePrefix && !(item.mediaAt || "").startsWith(filters.datePrefix)) {
    return false;
  }

  const query = String(filters.query || "").trim().toLowerCase();
  if (query && !searchableText(item).includes(query)) return false;

  return true;
}

export function filterMediaItems(
  items: LibraryMediaItem[],
  filters: LibraryFilterOptions,
): LibraryMediaItem[] {
  return items.filter((item) => mediaMatchesLibraryFilters(item, filters));
}

export function buildLibraryFacets(items: LibraryMediaItem[]) {
  const years = new Map<string, number>();
  const monthsByYear = new Map<string, Map<string, number>>();

  items.forEach((item) => {
    const mediaAt = item.mediaAt || "";
    const year = mediaAt.slice(0, 4);
    const month = mediaAt.slice(5, 7);
    if (!/^\d{4}$/.test(year)) return;

    years.set(year, (years.get(year) || 0) + 1);

    if (/^\d{2}$/.test(month)) {
      const yearMonths = monthsByYear.get(year) || new Map<string, number>();
      yearMonths.set(month, (yearMonths.get(month) || 0) + 1);
      monthsByYear.set(year, yearMonths);
    }
  });

  const yearList: YearFacet[] = Array.from(years.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([value, count]) => ({ value, count }));

  const monthMap = Object.fromEntries(
    Array.from(monthsByYear.entries()).map(([year, monthCounts]) => [
      year,
      Array.from(monthCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count })) satisfies MonthFacet[],
    ]),
  ) as Record<string, MonthFacet[]>;

  return {
    years: yearList,
    monthsByYear: monthMap,
  };
}

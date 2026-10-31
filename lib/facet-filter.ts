/**
 * Multi-value ("faceted") column filter helpers shared by `DataTable`.
 *
 * A facet filter value is the list of selected option values; an empty list
 * means "no filter". In the URL the list travels as one comma-separated param.
 */

/** Minimal row shape the filter needs, so it is testable without a table. */
type FacetRow = { getValue: (columnId: string) => unknown };

export function facetFilterFn(
  row: FacetRow,
  columnId: string,
  values: string[]
): boolean {
  return values.length === 0 || values.includes(String(row.getValue(columnId)));
}

/** Parses a `a,b` URL param into unique, non-empty values. */
export function parseFacetParam(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").filter(Boolean))];
}

/** Inverse of `parseFacetParam`; an empty selection serializes to "". */
export function serializeFacetParam(values: string[]): string {
  return values.join(",");
}
